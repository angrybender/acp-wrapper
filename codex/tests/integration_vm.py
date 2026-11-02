#!/usr/bin/env python3
"""Run the ACP integration matrix against a separate Codex runtime over SSH.

Uses the orchestrator's read-only Config service for SSH. Provider keys are read
from stdin or a local key file, never command arguments or saved reports.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import queue
import shlex
import sys
import threading
import time
import uuid

LAUNCH = r'''import os,json,pathlib
b=b''
while not b.endswith(b'\n'):b+=os.read(0,1)
p=json.loads(b);r=pathlib.Path(p['root']);r.mkdir(mode=0o700,parents=True,exist_ok=True)
h=r/'home';h.mkdir(exist_ok=True);w=r/'work';w.mkdir(exist_ok=True)
(h/'config.toml').write_text('model="'+p['model']+'"\nmodel_provider="routerai"\n[model_providers.routerai]\nname="RouterAI"\nbase_url="'+p['host']+'"\nenv_key="ACP_PROVIDER_KEY"\nwire_api="responses"\n')
os.environ.update(CODEX_HOME=str(h),CODEX_PATH=p['codex'],ACP_PROVIDER_KEY=p['key'],PATH='/home/user/.local/bin:'+os.environ['PATH'])
os.chdir(w);print('PID='+str(os.getpid()),flush=True);os.execv(p['binary'],[p['binary']])
'''
CAPS = {'_meta': {'orchestratorBackgroundTasks': 1, 'jetbrains': {'air': {
    'version': 1, 'capabilities': ['asyncTasks', 'nativeSubagentSessions', 'sessionFailure']}}}}
BG = ('Use exec_command with yield_time_ms=1000 to run exactly: {command}. '
      'Immediately finish STARTED when the command returns a running session. '
      'Do not wait, poll, stop it, use shell &, nohup or detach. Do not spawn agents.')


class RPCError(Exception):
    pass


class Runner:
    def __init__(self, args, key):
        import paramiko
        sys.path.insert(0, str(args.orchestrator))
        from settings.config import Config
        self.paramiko, self.Config = paramiko, Config
        self.args, self.key = args, key
        self.root = '/tmp/acp-wrapper-validation-' + uuid.uuid4().hex[:12]
        self.results = []

    def connect(self):
        host = self.Config.get('remote_server.host')
        part, separator, port = host.rpartition(':')
        host, port = (part, int(port)) if separator and port.isdigit() else (host, 22)
        client = self.paramiko.SSHClient()
        client.load_system_host_keys()
        client.set_missing_host_key_policy(self.paramiko.RejectPolicy())
        key = self.Config.get('remote_server.ssh_key')
        auth = {'key_filename': key} if key else {'password': self.Config.get('remote_server.password')}
        client.connect(host, port=port, username=self.Config.get('remote_server.username'),
                       allow_agent=False, look_for_keys=False, timeout=20, **auth)
        client.get_transport().set_keepalive(15)
        return client

    def save(self):
        self.args.results.write_text(json.dumps({'root': self.root, 'results': self.results}, indent=2))

    def run(self, name, function, **options):
        print('START ' + name, flush=True)
        client = None
        start = time.monotonic()
        try:
            client = Client(self, name, **options)
            detail = function(client)
            result = {'case': name, 'status': 'PASS', 'seconds': round(time.monotonic()-start, 2),
                      'detail': detail, 'events': client.events()}
        except Exception as error:
            result = {'case': name, 'status': 'FAIL', 'seconds': round(time.monotonic()-start, 2),
                      'error': (type(error).__name__ + ': ' + str(error)).replace(self.key, '[KEY]'),
                      'events': client.events() if client else {},
                      'answer': client.text()[-1200:] if client else ''}
        finally:
            if client:
                client.cleanup()
        self.results.append(result)
        self.save()
        print(json.dumps(result), flush=True)


class Client:
    def __init__(self, runner, name, capabilities=None, invalid_key=False):
        self.runner, self.root = runner, runner.root + '/' + name
        self.ssh = runner.connect()
        self.channel = self.ssh.get_transport().open_session()
        self.channel.exec_command('python3 -c ' + shlex.quote(LAUNCH))
        payload = {'root': self.root, 'key': 'invalid-test-key' if invalid_key else runner.key,
                   'binary': runner.args.binary, 'codex': runner.args.codex,
                   'model': runner.args.model, 'host': runner.args.host}
        self.channel.sendall((json.dumps(payload)+'\n').encode())
        self.stdin, self.stdout = self.channel.makefile_stdin('wb'), self.channel.makefile('rb')
        line = self.stdout.readline().decode()
        assert line.startswith('PID='), 'Missing test process handshake'
        self.pid = int(line[4:])
        self.queue, self.messages, self.answers = queue.Queue(), [], {}
        self.sequence, self.session_id, self.stderr = 0, None, ''

        def read():
            try:
                for line in self.stdout:
                    self.queue.put(json.loads(line))
            finally:
                self.queue.put(None)

        def stderr():
            while True:
                data = self.channel.recv_stderr(4096)
                if not data:
                    return
                self.stderr = (self.stderr+data.decode(errors='replace')).replace(runner.key, '[KEY]')[-6000:]
        threading.Thread(target=read, daemon=True).start()
        threading.Thread(target=stderr, daemon=True).start()
        self.initialized = self.call('initialize', {'protocolVersion': 1,
            'clientInfo': {'name': 'acp-wrapper-integration', 'version': '1'},
            'clientCapabilities': CAPS if capabilities is None else capabilities})

    def send(self, message):
        self.stdin.write((json.dumps(message)+'\n').encode())
        self.stdin.flush()

    def begin(self, method, params):
        self.sequence += 1
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        return self.sequence

    def pump(self, timeout=.15):
        try:
            message = self.queue.get(timeout=timeout)
        except queue.Empty:
            return
        if message is None:
            raise EOFError('ACP EOF ' + self.stderr[-250:])
        self.messages.append(message)
        if 'id' in message and 'method' in message:
            self.send({'jsonrpc': '2.0', 'id': message['id'], 'error': {
                'code': -32601, 'message': 'Client method not supported'}})
        elif 'id' in message:
            self.answers[message['id']] = message

    def wait(self, identifier, timeout=150):
        end = time.monotonic()+timeout
        while identifier not in self.answers:
            if time.monotonic() > end:
                raise TimeoutError('ACP request deadline')
            self.pump()
        message = self.answers.pop(identifier)
        if 'error' in message:
            raise RPCError(json.dumps(message['error']))
        return message.get('result')

    def call(self, method, params, timeout=150):
        return self.wait(self.begin(method, params), timeout)

    def new(self, mode=None):
        self.session_id = self.call('session/new', {'cwd': self.root+'/work', 'mcpServers': []})['sessionId']
        if mode:
            self.call('session/set_mode', {'sessionId': self.session_id, 'modeId': mode})
        return self.session_id

    def prompt(self, text, timeout=150):
        return self.call('session/prompt', {'sessionId': self.session_id,
            'prompt': [{'type': 'text', 'text': text}]}, timeout)

    def snapshot(self, **options):
        return self.call('_orchestrator/background', {'sessionId': self.session_id, **options}, 30)

    def idle(self, timeout=70):
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            state = self.snapshot()
            if not state['pending']:
                return state
            self.pump(.25)
        raise AssertionError('Drain did not become idle: ' + json.dumps(state))

    def remote(self, code):
        _, stdout, stderr = self.ssh.exec_command('python3 -c '+shlex.quote(code), timeout=30)
        result, error = stdout.read().decode(), stderr.read().decode()
        assert not error, error
        return result

    def file(self, name):
        return self.remote('from pathlib import Path;p=Path('+repr(self.root+'/work/'+name)+
                           ');print(p.read_text()if p.exists()else "MISSING")').strip()

    def live(self):
        return json.loads(self.remote('import os,json\nr='+repr(self.root)+'''\na=[]
for p in os.listdir('/proc'):
 if not p.isdigit():continue
 try:
  cwd=os.readlink('/proc/'+p+'/cwd');env=open('/proc/'+p+'/environ','rb').read().split(b'\\0')
  home=next((x.split(b'=',1)[1].decode()for x in env if x.startswith(b'CODEX_HOME=')),'')
  if cwd.startswith(r+'/')or home.startswith(r+'/'):a.append({'pid':int(p),'pgid':os.getpgid(int(p)),'exe':open('/proc/'+p+'/cmdline','rb').read().split(b'\\0')[0].decode(errors='replace')})
 except OSError:pass
print(json.dumps(a))'''))

    def stop(self, task_id):
        return self.call('_session/async_task/stop', {'sessionId': self.session_id, 'asyncTaskId': task_id})

    def finish(self, conditional=True):
        if conditional:
            end = time.monotonic()+30
            while True:
                state = self.idle()
                if self.snapshot(close=True, token=state['token'])['closed']:
                    break
                assert time.monotonic() < end, 'Conditional close did not stabilize'
        else:
            self.call('session/close', {'sessionId': self.session_id}, 30)
        self.stdin.close()
        self.channel.shutdown_write()
        end = time.monotonic()+10
        while not self.channel.exit_status_ready() and time.monotonic() < end:
            try:
                self.pump(.1)
            except EOFError:
                time.sleep(.03)
        assert self.channel.exit_status_ready(), 'ACP shutdown exceeded 10s'
        assert self.channel.recv_exit_status() == 0, self.stderr[-500:]
        end = time.monotonic()+5
        live = self.live()
        while live and time.monotonic() < end:
            time.sleep(.1)
            live = self.live()
        assert not live, {'live_after_exit': live}

    def cleanup(self):
        try:
            groups = {item['pgid'] for item in self.live()}
            self.remote('import os,signal\ngroups='+repr(list(groups))+'''
for group in groups:
 try:os.killpg(group,signal.SIGKILL)
 except ProcessLookupError:pass''')
        finally:
            self.channel.close()
            self.ssh.close()

    def text(self):
        return ''.join(message.get('params', {}).get('update', {}).get('content', {}).get('text', '')
            for message in self.messages if message.get('params', {}).get('update', {}).get('sessionUpdate') == 'agent_message_chunk')

    def events(self):
        return dict(Counter(message.get('params', {}).get('update', {}).get('sessionUpdate')
            for message in self.messages if message.get('method') == 'session/update'))


def rejected(function):
    try:
        function()
    except RPCError as error:
        return str(error)
    raise AssertionError('RPC unexpectedly succeeded')


def protocol(c):
    assert c.initialized['_meta']['orchestratorBackgroundTasks'] == {'version': 1}
    c.new(); state = c.idle()
    assert c.snapshot()['token'] == state['token']
    assert not c.snapshot(close=True, token='stale')['closed']
    assert not c.snapshot(close=True)['closed']
    errors = []
    for params in ({}, {'sessionId': 'missing'}, {'sessionId': c.session_id, 'close': 'true'},
                   {'sessionId': c.session_id, 'token': 1}, {'sessionId': c.session_id, 'extra': 1}):
        errors.append(rejected(lambda p=params: c.call('_orchestrator/background', p)))
    c.call('session/close', {'sessionId': c.session_id})
    errors.append(rejected(c.snapshot)); c.finish(False)
    return {'ids': ['ACP-01', 'ACP-04', 'ACP-05', 'ACP-06', 'ACP-07', 'ACP-08'], 'errors': errors}


def unsupported(c):
    assert 'orchestratorBackgroundTasks' not in c.initialized.get('_meta', {})
    c.new(); error = rejected(c.snapshot); c.finish(False)
    return {'ids': ['ACP-02', 'ACP-03'], 'error': error}


def concurrent_close(c):
    c.new(); state = c.idle(); params = {'sessionId': c.session_id, 'close': True, 'token': state['token']}
    first, second = c.begin('_orchestrator/background', params), c.begin('_orchestrator/background', params)
    outcomes = []
    for identifier in (first, second):
        try:
            outcomes.append(c.wait(identifier))
        except RPCError as failure:
            outcomes.append({'error': str(failure)})
    assert sum(outcome.get('closed') is True for outcome in outcomes) == 1, outcomes
    error = next(outcome['error'] for outcome in outcomes if 'error' in outcome); c.finish(False)
    return {'ids': ['ACP-09'], 'second_close': error}


def close_prompt_race(c):
    c.new(); state = c.idle()
    close = c.begin('_orchestrator/background', {'sessionId': c.session_id, 'close': True, 'token': state['token']})
    prompt = c.begin('session/prompt', {'sessionId': c.session_id,
        'prompt': [{'type': 'text', 'text': 'Use a shell command to write RACE_OK to race.txt and finish.'}]})
    result = c.wait(close)
    if result['closed']:
        rejected(lambda: c.wait(prompt)); assert c.file('race.txt') == 'MISSING'; c.finish(False)
    else:
        assert c.wait(prompt)['stopReason'] == 'end_turn'; assert c.file('race.txt') == 'RACE_OK'; c.finish()
    return {'ids': ['ACP-10'], 'close_won': result['closed']}


def busy(c):
    c.new(); prompt = c.begin('session/prompt', {'sessionId': c.session_id, 'prompt': [{'type': 'text',
        'text': 'Run foreground exec_command with yield_time_ms=10000: sleep 10; printf BUSY_OK > busy.txt. Finish after completion.'}]})
    state = c.snapshot(); assert state['pending'] and state['modelBusy']
    assert not c.snapshot(close=True, token=state['token'])['closed']
    assert c.wait(prompt)['stopReason'] == 'end_turn'; assert c.file('busy.txt') == 'BUSY_OK'; c.finish()
    return {'ids': ['ACP-11']}


def foreground(c):
    c.new(); c.prompt('Use the shell to write FOREGROUND_OK to result.txt, read it, and reply FOREGROUND_VERIFIED.')
    assert c.file('result.txt') == 'FOREGROUND_OK'; assert 'FOREGROUND_VERIFIED' in c.text(); c.finish()
    return {'ids': ['ACP-12']}


def finite(c):
    c.new(); c.prompt(BG.format(command='sleep 18; printf FINITE_OK > finite.txt'))
    state = c.snapshot(); assert state['pending'] and state['tasks']; assert c.file('finite.txt') == 'MISSING'
    assert not c.snapshot(close=True, token=state['token'])['closed']
    done = c.idle(); assert any(task['state'] == 'completed' for task in done['tasks'])
    assert c.file('finite.txt') == 'FINITE_OK'; assert not c.snapshot(close=True, token=state['token'])['closed']
    c.prompt('Read finite.txt and reply FINITE_VERIFIED.'); assert 'FINITE_VERIFIED' in c.text(); c.finish()
    return {'ids': ['ACP-13'], 'terminal': done['tasks']}


def repeated(c):
    c.new()
    for number in range(1, 5):
        c.prompt(BG.format(command=f'sleep 5; printf ROUND_{number} > round{number}.txt'))
        c.idle(); assert c.file(f'round{number}.txt') == f'ROUND_{number}'
    c.prompt('Read round1.txt to round4.txt and reply FOUR_ROUNDS_VERIFIED.')
    assert 'FOUR_ROUNDS_VERIFIED' in c.text(); c.finish()
    return {'ids': ['ACP-14'], 'generations': 4}


def parallel(c):
    c.new(); c.prompt('Launch exactly two native exec_command tasks with yield_time_ms=1000: sleep 12; printf PARALLEL_A > a.txt and sleep 18; printf PARALLEL_B > b.txt. Immediately finish after launching both. Do not poll, wait, use shell & or nohup.')
    state = c.snapshot(); assert len(state['tasks']) == 2 and state['pending']
    c.idle(); assert c.file('a.txt') == 'PARALLEL_A'; assert c.file('b.txt') == 'PARALLEL_B'
    c.prompt('Read a.txt and b.txt and reply BOTH_VERIFIED.'); assert 'BOTH_VERIFIED' in c.text(); c.finish()
    return {'ids': ['ACP-15']}


def failed(c):
    c.new(); c.prompt(BG.format(command='sleep 6; printf EXPECTED_FAILURE >&2; exit 7'))
    state = c.idle(); assert any(task['state'] == 'failed' for task in state['tasks'])
    c.prompt('Exit 7 was expected. Do not retry. Inspect its output and write FAILURE_HANDLED to handled.txt.')
    assert c.file('handled.txt') == 'FAILURE_HANDLED'; c.finish()
    return {'ids': ['ACP-16'], 'terminal': state['tasks']}


def stopping(c):
    c.new(); c.prompt(BG.format(command='sleep 60; printf AFTER_STOP > stopped.txt'))
    state = c.snapshot(); task = next(task for task in state['tasks'] if task['state'] == 'running')
    assert c.file('stopped.txt') == 'MISSING', 'Command already finished before stop'
    assert c.stop(task['id'])['stopped']; state = c.idle()
    assert any(task['state'] == 'stopped' for task in state['tasks']), state
    assert not c.stop(task['id'])['stopped']; assert not c.stop('missing')['stopped']; c.finish()
    end = time.monotonic()+65
    while time.monotonic() < end:
        assert c.file('stopped.txt') == 'MISSING', 'Side effect after confirmed stop'
        time.sleep(.4)
    return {'ids': ['ACP-17', 'ACP-18'], 'late_file': 'MISSING'}


def cancel(c):
    c.new(); prompt = c.begin('session/prompt', {'sessionId': c.session_id, 'prompt': [{'type': 'text',
        'text': 'Run exec_command in foreground with yield_time_ms=10000: echo $$ > cancel.pid; sleep 30; printf AFTER_CANCEL > cancel.txt. Wait for completion.'}]})
    end = time.monotonic()+40
    while time.monotonic() < end and c.file('cancel.pid') == 'MISSING':
        c.pump(.2)
    assert c.file('cancel.pid') != 'MISSING', 'Command never started'
    c.send({'jsonrpc': '2.0', 'method': 'session/cancel', 'params': {'sessionId': c.session_id}})
    result = c.wait(prompt, 35); assert result['stopReason'] == 'cancelled'
    c.finish(False); assert c.file('cancel.txt') == 'MISSING'
    return {'ids': ['ACP-19'], 'result': result['stopReason']}


def server(c):
    c.new('agent-full-access'); sftp = c.ssh.open_sftp()
    with sftp.open(c.root+'/work/server.py', 'w') as file:
        file.write("import http.server,pathlib,os\ns=http.server.HTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler)\npathlib.Path('server.port').write_text(str(s.server_port))\npathlib.Path('server.pid').write_text(str(os.getpid()))\ns.serve_forever()\n")
    sftp.close(); c.prompt(BG.format(command='python3 -u server.py')); state = c.snapshot(); assert state['pending']
    port = int(c.file('server.port'))
    status = c.remote('import urllib.request;print(urllib.request.urlopen("http://127.0.0.1:'+str(port)+'/",timeout=3).status)').strip()
    assert status == '200'; assert not c.snapshot(close=True, token=state['token'])['closed']
    task = next(task for task in state['tasks'] if task['state'] == 'running'); assert c.stop(task['id'])['stopped']
    c.idle(); c.prompt('The client stopped the server. Do not restart it. Verify its process is gone and finish.'); c.finish()
    return {'ids': ['ACP-20'], 'http_status': status, 'mode': 'agent-full-access'}


def subagent(c):
    c.new(); c.prompt('This explicitly authorizes one child. Spawn one subagent to run sleep 5; printf CHILD_OK > child.txt in this directory. Wait for the child, read child.txt yourself, and reply CHILD_VERIFIED.')
    assert c.events().get('subagent_spawned', 0) > 0; assert c.file('child.txt') == 'CHILD_OK'
    c.idle(); c.finish(); return {'ids': ['ACP-21']}


def child_background(c):
    c.new(); c.prompt('This explicitly authorizes one child. Ask it to run exec_command with yield_time_ms=1000: sleep 18; printf CHILD_BG_OK > childbg.txt in this directory, and return immediately without waiting or polling. Parent: finish CHILD_STARTED as soon as the child returns, without polling its command. Do not use shell & or nohup.')
    assert c.events().get('subagent_spawned', 0) > 0; state = c.snapshot(); assert state['tasks'], state
    c.idle(); assert c.file('childbg.txt') == 'CHILD_BG_OK'; c.prompt('Read childbg.txt and reply CHILD_BG_VERIFIED.')
    assert 'CHILD_BG_VERIFIED' in c.text(); c.finish(); return {'ids': ['ACP-22']}


def child_stop(c):
    c.new(); c.prompt('This explicitly authorizes one child. Ask it to run exec_command with yield_time_ms=1000: sleep 60; printf AFTER_CHILD_STOP > childstop.txt in this directory. Child returns immediately without polling; parent finishes immediately after the child returns. Do not use shell & or nohup.')
    state = c.snapshot(); task = next(task for task in state['tasks'] if task['state'] == 'running')
    assert c.stop(task['id'])['stopped']; c.idle(); c.finish()
    end = time.monotonic()+65
    while time.monotonic() < end:
        assert c.file('childstop.txt') == 'MISSING'; time.sleep(.4)
    return {'ids': ['ACP-23'], 'variant': 'explicit client stop of child native task'}


def resume(c):
    c.new(); identifier = c.session_id; c.prompt('Write RESUME_OK to resume.txt using the shell and finish SAVED.')
    c.call('session/close', {'sessionId': identifier})
    c.call('session/load', {'sessionId': identifier, 'cwd': c.root+'/work', 'mcpServers': []})
    c.prompt('Read resume.txt and reply RESUME_VERIFIED.'); assert 'RESUME_VERIFIED' in c.text(); c.finish()
    return {'ids': ['ACP-24']}


def sdk_loss(c):
    c.new(); c.prompt(BG.format(command='sleep 90; printf MUST_NOT_EXIST > lost.txt'))
    assert c.snapshot()['pending']
    pids = [item['pid'] for item in c.live() if 'codex' in item['exe'] and not item['exe'].endswith('codex-linux-sandbox')]
    assert pids
    c.remote('import os,signal\npids='+repr(pids)+'''\nfor pid in pids:
 try:os.kill(pid,signal.SIGKILL)
 except ProcessLookupError:pass''')
    try:
        state = c.snapshot(); assert state['pending'] and not state['closed']; detail = state
    except (RPCError, EOFError) as error:
        detail = str(error)
    return {'ids': ['ACP-25'], 'outcome': detail}


def auth_failure(c):
    c.new()
    try:
        result = c.prompt('Reply PROVIDER_OK without tools.', timeout=45)
    except RPCError as error:
        result = {'rpc_error': str(error)}
    assert 'PROVIDER_OK' not in c.text()
    assert result.get('rpc_error') or result.get('_meta', {}).get('jetbrains', {}).get('air', {}).get('sessionFailure'), result
    return {'ids': ['ACP-26'], 'outcome': result}


CASES = {'protocol': protocol, 'unsupported': unsupported, 'partial': unsupported, 'concurrent-close': concurrent_close,
         'close-prompt-race': close_prompt_race, 'busy': busy, 'foreground': foreground, 'finite': finite,
         'repeated': repeated, 'parallel': parallel, 'failed': failed, 'stop': stopping, 'cancel': cancel,
         'server': server, 'subagent': subagent, 'child-background': child_background,
         'child-stop': child_stop, 'resume': resume, 'sdk-loss': sdk_loss, 'auth-failure': auth_failure}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--orchestrator', type=Path, required=True)
    parser.add_argument('--binary', required=True, help='Installed remote ACP executable')
    parser.add_argument('--codex', default='/home/user/.local/bin/codex')
    parser.add_argument('--host', default='https://routerai.ru/api/v1')
    parser.add_argument('--model', default='openai/gpt-6-luna')
    parser.add_argument('--key-file', type=Path)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('cases', nargs='*', choices=list(CASES))
    args = parser.parse_args()
    key = args.key_file.read_text().strip() if args.key_file else sys.stdin.readline().strip()
    if not key:
        parser.error('Provide a provider key through stdin or --key-file')
    runner = Runner(args, key)
    for name in args.cases or CASES:
        options = {'capabilities': {}} if name == 'unsupported' else {'capabilities': {'_meta': {'orchestratorBackgroundTasks': 1}}} if name == 'partial' else {'invalid_key': True} if name == 'auth-failure' else {}
        runner.run(name, CASES[name], **options)
    print('SUMMARY '+json.dumps({'root': runner.root, 'passed': sum(item['status'] == 'PASS' for item in runner.results),
                                 'failed': sum(item['status'] == 'FAIL' for item in runner.results)}), flush=True)
    return int(any(item['status'] == 'FAIL' for item in runner.results))


if __name__ == '__main__':
    sys.exit(main())
