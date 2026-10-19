#!/usr/bin/env python3
"""Private Pi/tmux recovery checkpoints. Does not snapshot process memory or credentials."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local-session'


def tmux(*args):
    return subprocess.check_output(['tmux', *args], text=True).strip()


def process_sessions(pid):
    """Inspect only session-path variables, never retain auth/environment dumps."""
    processes = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / 'status').read_text()
            parent = int(re.search(r'^PPid:\s+(\d+)', status, re.M)[1])
            processes.setdefault(parent, []).append(int(entry.name))
        except (OSError, TypeError):
            pass
    found = []
    pending = [(pid, 0)]
    while pending:
        current, depth = pending.pop()
        pending.extend((child, depth + 1) for child in processes.get(current, []))
        try:
            env = dict(item.split(b'=', 1) for item in Path(f'/proc/{current}/environ').read_bytes().split(b'\0') if b'=' in item)
            value = (env.get(b'PI_SUBAGENT_SESSION') or env.get(b'PI_SESSION_FILE', b'')).decode()
            args = Path(f'/proc/{current}/cmdline').read_bytes().decode().split('\0')
            if '--session' in args:
                index = args.index('--session')
                if index + 1 < len(args) and Path(args[index + 1]).is_file():
                    value = args[index + 1]
            if value and Path(value).is_file():
                found.append((depth, value))
        except (OSError, UnicodeError):
            pass
    return max(found, default=(0, None))[1]


def checkpoint(session):
    os.umask(0o077)
    BASE.mkdir(mode=0o700, exist_ok=True)
    target = BASE / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    target.mkdir(mode=0o700)
    windows = []
    for line in tmux('list-windows', '-t', session, '-F', '#{window_id}\t#{window_name}\t#{window_layout}\t#{window_width}\t#{window_height}').splitlines():
        wid, name, layout, width, height = line.split('\t')
        panes = []
        for item in tmux('list-panes', '-t', wid, '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_active}').splitlines():
            pane, pid, cwd, active = item.split('\t')
            source = process_sessions(int(pid))
            record = dict(id=pane, cwd=cwd, active=active == '1', session=source)
            if source:
                backup = f'pane-{pane[1:]}.jsonl'
                # Read once: Pi append-only transcript remains the authoritative live file.
                (target / backup).write_bytes(Path(source).read_bytes())
                record['backup'] = backup
            (target / f'pane-{pane[1:]}.txt').write_text(tmux('capture-pane', '-p', '-t', pane, '-S', '-2000'))
            panes.append(record)
        windows.append(dict(name=name, layout=layout, width=int(width), height=int(height), panes=panes))
    state = dict(created=datetime.datetime.now().isoformat(), session=session, cwd=str(ROOT), windows=windows)
    (target / 'state.json').write_text(json.dumps(state, indent=2) + '\n')
    (target / 'worktree-status.txt').write_text(subprocess.check_output(['git', 'status', '--short'], cwd=ROOT, text=True))
    (target / 'tracked.patch').write_bytes(subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=ROOT))
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    with tarfile.open(target / 'worktree.tar.gz', 'w:gz', dereference=False) as archive:
        for relative in paths:
            path = ROOT / relative
            if relative and (path.is_file() or path.is_symlink()):
                archive.add(path, arcname=relative, recursive=False)
    latest = BASE / 'latest'
    if latest.is_symlink():
        latest.unlink()
    elif latest.exists():
        raise RuntimeError('Refusing to replace a non-symlink latest path')
    latest.symlink_to(target.name)
    print(target)
    print('Live recovery: tmux attach-session -t ' + shlex.quote(session))
    print('After tmux exits: python3 tools/session-checkpoint.py restore')


def restore(source, name):
    directory = Path(source).resolve()
    state = json.loads((directory / 'state.json').read_text())
    session = name or state['session']
    if subprocess.run(['tmux', 'has-session', '-t', '=' + session], capture_output=True).returncode == 0:
        print('Session is still live; no duplicate agents launched. Run: tmux attach-session -t ' + shlex.quote(session))
        return
    pi = shutil.which('pi')
    if not pi:
        raise RuntimeError('pi must be installed before restoring saved conversations')
    for index, window in enumerate(state['windows']):
        pane_ids = []
        for position, pane in enumerate(window['panes']):
            original = pane.get('session')
            path = Path(original) if original and Path(original).is_file() else directory / pane.get('backup', 'missing')
            command = shlex.join([pi, '--session', str(path)]) if path.is_file() else (os.environ.get('SHELL') or '/bin/sh')
            cwd = pane['cwd'] if Path(pane['cwd']).is_dir() else str(ROOT)
            if index == 0 and position == 0:
                pid = tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-n', window['name'], '-x', str(window['width']), '-y', str(window['height']), '-c', cwd, command)
            elif position == 0:
                pid = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', session, '-n', window['name'], '-c', cwd, command)
            else:
                pid = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', pane_ids[0], '-c', cwd, command)
                tmux('select-layout', '-t', pane_ids[0], 'tiled')
            pane_ids.append(pid)
        mapping = {p['id'][1:]: new[1:] for p, new in zip(window['panes'], pane_ids)}
        layout = re.sub(r'(\d+x\d+,\d+,\d+,)(\d+)', lambda match: match[1] + mapping.get(match[2], match[2]), window['layout'].split(',', 1)[1])
        checksum = 0
        for char in layout:
            checksum = (((checksum >> 1) | ((checksum & 1) << 15)) + ord(char)) & 65535
        tmux('select-layout', '-t', pane_ids[0], f'{checksum:04x},{layout}')
        for old, new in zip(window['panes'], pane_ids):
            if old['active']:
                tmux('select-pane', '-t', new)
    tmux('select-window', '-t', session + ':' + state['windows'][0]['name'])
    print('Restored layout and Pi conversations. In-flight calls and subagent supervision are not restored.')
    print('Attach: tmux attach-session -t ' + shlex.quote(session))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['save', 'restore'], nargs='?', default='save')
    parser.add_argument('--session', help='tmux session name; default current session for save, saved name for restore')
    parser.add_argument('--snapshot', default=str(BASE / 'latest'))
    args = parser.parse_args()
    if args.action == 'save':
        checkpoint(args.session or tmux('display-message', '-p', '#S'))
    else:
        restore(args.snapshot, args.session)
