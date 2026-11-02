#!/usr/bin/env python3
"""Exercise INT-01..07 through the real orchestrator transport, outside its DB."""
import argparse
import json
from pathlib import Path
import shlex
import sys
import threading
import time
from integration_vm import Runner


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--orchestrator', type=Path, required=True)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--codex', default='/home/user/.local/bin/codex')
    parser.add_argument('--host', default='https://routerai.ru/api/v1')
    parser.add_argument('--model', default='openai/gpt-6-luna')
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--key-file', type=Path)
    parser.add_argument('cases', nargs='*', choices=['INT-0'+str(i) for i in range(1, 8)])
    args = parser.parse_args()
    key = args.key_file.read_text().strip() if args.key_file else sys.stdin.readline().strip()
    if not key:
        parser.error('Provide key via stdin or --key-file')
    runner = Runner(args, key)
    sys.path.insert(0, str(args.orchestrator))
    import agent_remote
    import paramiko
    ssh = runner.connect(); sftp = ssh.open_sftp(); sftp.mkdir(runner.root, 0o700)
    with sftp.open(runner.root+'/key', 'w') as file:
        file.write(key)
    sftp.chmod(runner.root+'/key', 0o600)
    launch = '''import os,json,pathlib
r=pathlib.Path(__file__).parent;h=r/('home-'+pathlib.Path.cwd().name);h.mkdir(mode=0o700,exist_ok=True)
p=json.loads((r/'provider.json').read_text())
(h/'config.toml').write_text('model="'+p['model']+'"\\nmodel_provider="routerai"\\n[model_providers.routerai]\\nname="RouterAI"\\nbase_url="'+p['host']+'"\\nenv_key="ACP_PROVIDER_KEY"\\nwire_api="responses"\\n')
token='invalid-test-key'if 'invalid-key'in pathlib.Path.cwd().name else(r/'key').read_text()
os.environ.update(CODEX_HOME=str(h),CODEX_PATH=p['codex'],ACP_PROVIDER_KEY=token,PATH='/home/user/.local/bin:'+os.environ['PATH'])
os.execv(p['binary'],[p['binary']])
'''
    for name, content in [('launch.py', launch), ('provider.json', json.dumps({
        'model': args.model, 'host': args.host, 'binary': args.binary, 'codex': args.codex}))]:
        with sftp.open(runner.root+'/'+name, 'w') as file:
            file.write(content)
        sftp.chmod(runner.root+'/'+name, 0o600)
    sftp.close()
    base = {key: runner.Config.get(key) for key in ['remote_server.host', 'remote_server.username',
        'remote_server.password', 'remote_server.ssh_key']}
    base.update({'tasks.base_dir': runner.root, 'agent.shell': 'python3 '+shlex.quote(runner.root+'/launch.py'),
        'agent.prompt': '', 'agent.acp_wait_background_tasks': True, 'agent.acp_background_quiet_timeout': 1,
        'tasks.init_script_path': '', 'tasks.init_script_text': ''})
    actual_client = paramiko.SSHClient; clients = []
    def capture():
        client = actual_client(); clients.append(client); return client
    paramiko.SSHClient = capture
    original_request = agent_remote._request
    selected_mode = [None]
    def request(*positional, **keywords):
        result = original_request(*positional, **keywords)
        if positional[3] == 'session/new' and selected_mode[0]:
            changed = list(positional); changed[2] += 900000; changed[3] = 'session/set_mode'
            changed[4] = {'sessionId': result['sessionId'], 'modeId': selected_mode[0]}
            original_request(*changed, **keywords)
        return result
    agent_remote._request = request
    def remote(code):
        stdin, stdout, stderr = ssh.exec_command('python3 -c '+shlex.quote(code), timeout=30)
        stdin.close(); output, error = stdout.read().decode(), stderr.read().decode()
        stdout.close(); stderr.close(); assert not error, error
        return output
    cases = [
        ('INT-01', 'quiet60', 'Run exec_command with yield_time_ms=1000: sleep 18; printf INTEGRATION_OK > result.txt. Immediately finish STARTED without polling. On a later verification prompt read result.txt and reply VERIFIED_INTEGRATION_OK.', 240, 60, True, 'INTEGRATION_OK', None),
        ('INT-02', 'failed-server', "Create server.py: import http.server,pathlib,os; s=http.server.HTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler); pathlib.Path('server.pid').write_text(str(os.getpid())); pathlib.Path('server.port').write_text(str(s.server_port)); s.serve_forever(). Launch native exec_command tasks with yield_time_ms=1000: python3 -u server.py and sleep 6; printf EXPECTED_FAILURE >&2; exit 7. Immediately finish STARTED without polling. On later verification inspect expected exit 7, check HTTP 200, stop the disposable server using its recorded PID, verify its exit and write RECONCILED_OK to result.txt. Do not ask the user.", 240, 1, True, 'RECONCILED_OK', 'agent-full-access'),
        ('INT-03', 'repeated', 'First run exec_command with yield_time_ms=1000: sleep 6; printf FIRST_OK > first.txt. Immediately finish STARTED. On the first later verification prompt start one more native task: sleep 8; printf SECOND_OK > second.txt, with yield_time_ms=1000, then immediately finish SECOND_STARTED without waiting. On the next verification read both files and write REPEAT_OK to result.txt. Never duplicate work or stop finite commands.', 240, 1, True, 'REPEAT_OK', None),
        ('INT-04', 'deadline', 'Run exec_command with yield_time_ms=1000: sleep 120; printf MUST_NOT_EXIST > result.txt. Immediately finish STARTED without polling. Never stop this necessary finite task.', 25, 1, True, 'MISSING', None),
        ('INT-05', 'ssh-loss', 'Run exec_command with yield_time_ms=1000: sleep 120; printf MUST_NOT_EXIST > result.txt. Immediately finish STARTED without polling or stopping it.', 50, 1, True, 'MISSING', None),
        ('INT-06', 'disabled', 'Use a foreground shell command to write DISABLED_OK to result.txt and finish. No background tasks.', 90, 1, False, 'DISABLED_OK', None),
        ('INT-07', 'invalid-key', 'Reply PROVIDER_OK without tools.', 25, 1, True, 'MISSING', None),
    ]
    logs_dir = args.orchestrator/'data/logs'
    before = set(logs_dir.glob('*'))
    try:
        for identifier, name, prompt, timeout, quiet, wait, want, mode in cases:
            if args.cases and identifier not in args.cases:continue
            print('START '+identifier+' '+name, flush=True)
            selected_mode[0] = mode
            config = {**base, 'agent.agent_timeout': timeout, 'agent.acp_background_quiet_timeout': quiet,
                      'agent.acp_wait_background_tasks': wait}
            task_id = 'CODEX-EDGE-'+runner.root.rsplit('-', 1)[-1]+'-'+name
            directory = runner.root+'/'+task_id
            for artifact in ('server.py', 'server.pid', 'server.port', 'first.txt', 'second.txt', 'result.txt'):
                prompt = prompt.replace(artifact, directory+'/'+artifact)
            prompt += '\nUse the absolute artifact paths above and workdir '+directory+'. Never put output artifacts in requirements directories.'
            messages, logs, cut = [], [], [False]
            def message(text):
                messages.append(text)
                if name == 'ssh-loss' and 'STARTED' in text and not cut[0]:
                    cut[0] = True; threading.Timer(.2, lambda: clients[-1].close()).start()
            start = time.monotonic()
            try:
                outcome = agent_remote.run_remote({'task_id': task_id, 'title': name,
                    'description': prompt, 'comment': prompt}, [], config, lambda _: None,
                    logs.append, lambda: None, message)
                error = None
            except Exception as failure:
                outcome, error = None, str(failure).replace(key, '[KEY]')
            directory = runner.root+'/'+task_id
            contents = remote('from pathlib import Path;p=Path('+repr(directory+'/result.txt')+');print(p.read_text()if p.exists()else "MISSING")').strip()
            live = json.loads(remote('import os,json\nr='+repr(directory)+'''\na=[]
for pid in os.listdir('/proc'):
 if not pid.isdigit():continue
 try:
  if os.readlink('/proc/'+pid+'/cwd').startswith(r):a.append({'pid':int(pid),'pgid':os.getpgid(int(pid))})
 except OSError:pass
print(json.dumps(a))'''))
            negative = identifier in ('INT-04', 'INT-05', 'INT-07')
            passed = (error is not None and contents == want) if negative else (outcome is not None and contents == want and not live)
            result = {'case': identifier, 'name': name, 'status': 'PASS' if passed else 'FAIL',
                'seconds': round(time.monotonic()-start, 2), 'outcome': outcome, 'error': error,
                'file': contents, 'live_after_run': live, 'mode': mode or 'agent',
                'answer': messages[-1] if messages else '', 'logs': '\n'.join(logs)[-5000:]}
            runner.results.append(result); runner.save(); print(json.dumps(result), flush=True)
            if live:
                remote('import os,signal\ngroups='+repr(list({item['pgid'] for item in live}))+'''
for group in groups:
 try:os.killpg(group,signal.SIGKILL)
 except ProcessLookupError:pass''')
            for file in set(logs_dir.glob('*'))-before:
                if task_id in file.name:
                    assert key.encode() not in file.read_bytes(), 'Secret found in test raw log'
                    file.unlink()
    finally:
        paramiko.SSHClient = actual_client; agent_remote._request = original_request
        ssh.close()
    return int(any(item['status'] == 'FAIL' for item in runner.results))


if __name__ == '__main__':
    sys.exit(main())
