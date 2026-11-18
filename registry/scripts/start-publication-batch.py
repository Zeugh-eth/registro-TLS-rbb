#!/usr/bin/env python3
"""Start one authorized, resumable batch independently of the chat/terminal."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import shutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--end', required=True)
    parser.add_argument('--retry-failed', action='store_true')
    args = parser.parse_args()
    end = dt.date.fromisoformat(args.end)
    start = end - dt.timedelta(days=364)
    root = Path(__file__).resolve().parents[1]
    state = root / 'state'
    batch = state / 'batches' / f'{start}_{end}'
    if not (batch / 'plan.json').is_file():
        raise SystemExit('Prepare o inventário antes de iniciar o lote.')
    if not (state / 'secrets/batch-writer.key').is_file():
        raise SystemExit('Configure a chave local com npm run batch:key.')
    if (state / 'batch-writer.lock').exists() or (batch / 'plan.lock').exists():
        raise SystemExit('Já existe uma trava do lote. Aguarde o processo atual; não inicie outro.')
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js não encontrado no PATH.')
    command = [node, str(root / 'scripts/run-publication-batch.mjs'),
               '--end', str(end), '--execute']
    if args.retry_failed:
        command.append('--retry-failed')
    # Credentials from the interactive shell are not inherited by the worker.
    environment = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
                   'HOME': str(Path.home()), 'RBB_RPC_TRANSPORT': 'direct',
                   'LANG': 'en_US.UTF-8'}
    descriptors = []
    try:
        for name in ['batch-365.stdout.log', 'batch-365.stderr.log']:
            fd = os.open(state / name, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            descriptors.append(fd)
            if os.fstat(fd).st_uid != os.getuid():
                raise SystemExit('Log do lote pertence a outro usuário.')
            os.fchmod(fd, 0o600)
        worker = subprocess.Popen(command, cwd=root, env=environment,
                                  stdin=subprocess.DEVNULL, stdout=descriptors[0], stderr=descriptors[1],
                                  start_new_session=True, close_fds=True)
        metadata = {'pid': worker.pid, 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                    'window': {'start': str(start), 'end': str(end)}, 'transport': 'direct',
                    'stdout': str(state / 'batch-365.stdout.log'),
                    'stderr': str(state / 'batch-365.stderr.log')}
        (batch / 'runner.json').write_text(json.dumps(metadata, indent=2) + '\n')
        print(json.dumps(metadata))
    finally:
        for fd in descriptors:
            os.close(fd)


if __name__ == '__main__':
    main()
