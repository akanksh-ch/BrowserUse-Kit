import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

// Fedora's iptables_t SELinux transition can hide writes to inherited Node
// socketpair stdio. A real anonymous pipe captures output without disabling MAC.
// Only the fixed firewall-read command below uses this trusted relay.
export const FIREWALL_PIPE_RELAY = `import subprocess,sys
try:
 p=subprocess.run(sys.argv[1:],capture_output=True,timeout=8)
 if len(p.stdout)+len(p.stderr)>262144: sys.exit(125)
 sys.stdout.buffer.write(p.stdout);sys.stderr.buffer.write(p.stderr)
 sys.exit(p.returncode)
except subprocess.TimeoutExpired:
 sys.stderr.write('Firewall read timed out\\n');sys.exit(124)
`;

const exec = promisify(execFile);
export type NamespaceRunner = (file: string, args: string[]) => Promise<string>;
const boundedRun: NamespaceRunner = async (file, args) => String((await exec(file, args, {
  timeout: 10_000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL',
})).stdout);

/** Trusted control-plane code only. Never pass agent-selected executables/args.
 * No TCP port publication or browser-network attachment of the utility occurs.
 * A successful probe is not permission to expose CDP/VNC through the gateway.
 */
export class RootlessPodmanControl {
  constructor(private readonly run: NamespaceRunner = boundedRun) {}

  private async inspect(workspace: string, role: 'browser' | 'utility') {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(workspace)) throw Error('Invalid workspace identifier');
    if (role !== 'browser' && role !== 'utility') throw Error('Invalid workspace role');
    if ((await this.run('podman', ['info', '--format', '{{.Host.Security.Rootless}}'])).trim() !== 'true') {
      throw Error('Rootless Podman required; do not fall back to host networking');
    }
    const name = `buk-${workspace}-${role}`;
    const rows = JSON.parse(await this.run('podman', ['inspect', name]));
    if (!Array.isArray(rows) || rows.length !== 1) throw Error('Ambiguous workspace container');
    const c = rows[0], networks = c?.NetworkSettings?.Networks;
    if (c?.Config?.Labels?.['browseruse.workspace'] !== workspace || !c?.State?.Running ||
        !Number.isSafeInteger(c.State.Pid) || c.State.Pid < 2 || !c.HostConfig ||
        c.HostConfig.Privileged || c.HostConfig.NetworkMode === 'host' ||
        Object.keys(c.HostConfig.PortBindings ?? {}).length || !networks ||
        Object.keys(networks).length !== 1 || !networks[name] || isIP(networks[name].IPAddress) !== 4) {
      throw Error('Unsafe workspace namespace');
    }
    return { pid: String(c.State.Pid), address: networks[name].IPAddress as string };
  }

  /** Inspect firewall from its owning user namespace, not the unprivileged host. */
  async firewall(workspace: string, role: 'browser' | 'utility', family: 'iptables' | 'ip6tables') {
    if (family !== 'iptables' && family !== 'ip6tables') throw Error('Invalid firewall family');
    const { pid } = await this.inspect(workspace, role);
    const rules = await this.run('podman', ['unshare', 'python3', '-c', FIREWALL_PIPE_RELAY, 'nsenter', '-t', pid, '-n', family, '-S', 'OUTPUT']);
    if (!rules.trim() || !/^-P OUTPUT (ACCEPT|DROP)$/m.test(rules)) throw Error('Firewall rules unavailable; refuse readiness');
    return rules;
  }

  /** Execute a bounded trusted control probe in Podman's rootless bridge netns.
   * This is NOT the browser/utility container netns: the probe must traverse the
   * private bridge, just as a properly attached control service would.
   * Long-lived MCP stdio workers require their own supervised spawn adapter;
   * host Node fetch()/net.connect() do not inherit this child's namespace.
   */
  async probe(workspace: string, command: (address: string) => { file: string; args: string[] }) {
    const { address } = await this.inspect(workspace, 'browser');
    const { file, args } = command(address);
    if (!file || file.startsWith('-')) throw Error('Trusted executable required');
    return this.run('podman', ['unshare', '--rootless-netns', file, ...args]);
  }
}
