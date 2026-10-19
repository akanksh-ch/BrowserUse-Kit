#!/usr/bin/env bash
# Docker/Podman reference deployment; no host ports are published.
set -euo pipefail
cd "$(dirname "$0")/.."
OCI=${OCI:-${OCI_RUNTIME:-docker}}
operation=${1:?build|start|stop|delete|inspect}
id=${2:-}
if [[ "$operation" == build ]]; then
  : "${CHROME_VERSION:?Set exact Google Chrome Debian package version}"
  "$OCI" build --build-arg "CHROME_VERSION=$CHROME_VERSION" -t browseruse-browser:local containers/browser
  "$OCI" build -t browseruse-utility:local containers/utility
  "$OCI" build -t browseruse-egress:local containers/egress
  mkdir -p containers/manifests
  "$OCI" image inspect browseruse-browser:local browseruse-utility:local browseruse-egress:local > containers/manifests/images.json
  for image in browser utility egress; do
    "$OCI" run --rm --entrypoint /bin/sh "browseruse-$image:local" -c 'cat /opt/browseruse/packages.lock' > "containers/manifests/$image.packages.lock"
  done
  exit
fi
[[ "$id" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || { echo 'Invalid workspace ID' >&2; exit 1; }
p="buk-$id"
profile=${PROFILE_VOLUME:-$p-profile}
files=${FILES_VOLUME:-$p-files}
[[ "$profile" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && "$files" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1
case "$operation" in
start)
  for cmd in nsenter iptables ip6tables ip python3; do command -v "$cmd" >/dev/null; done
  ns() { nsenter "$@"; }
  if [[ $EUID != 0 ]]; then
    # docker may be the Podman compatibility wrapper. Require actual Podman
    # rootless ownership, not a privileged helper or a host-net fallback.
    [[ $("$OCI" info --format '{{.Host.Security.Rootless}}') == true ]] || { echo 'Non-root deployment requires rootless Podman' >&2; exit 1; }
    ns() { "$OCI" unshare nsenter "$@"; }
  fi
  for net in browser utility; do "$OCI" network inspect "$p-$net" >/dev/null 2>&1 || "$OCI" network create --internal "$p-$net" >/dev/null; done
  "$OCI" network inspect "$p-outbound" >/dev/null 2>&1 || "$OCI" network create "$p-outbound" >/dev/null
  for vol in "$profile" "$files"; do "$OCI" volume inspect "$vol" >/dev/null 2>&1 || "$OCI" volume create "$vol" >/dev/null; done
  # Existing containers must be stopped/removed before start; prevents duplicate runtimes.
  host_ips=$(ip -j address | python3 -c 'import json,sys; print(",".join(a["local"] for i in json.load(sys.stdin) for a in i.get("addr_info",[])))')
  "$OCI" run -d -e "DENY_CIDRS=$host_ips${DENY_CIDRS:+,$DENY_CIDRS}" --name "$p-egress" --label "browseruse.workspace=$id" --network "$p-outbound" --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --pids-limit 128 browseruse-egress:local >/dev/null
  trap '"$OCI" rm -f "$p-browser" "$p-utility" "$p-egress" >/dev/null 2>&1 || true' ERR
  for net in browser utility; do "$OCI" network connect --alias egress "$p-$net" "$p-egress"; done
  proxy_ip() { "$OCI" inspect -f "{{(index .NetworkSettings.Networks \"$p-$1\").IPAddress}}" "$p-egress"; }
  bproxy=$(proxy_ip browser); uproxy=$(proxy_ip utility)
  "$OCI" run -d --name "$p-browser" --label "browseruse.workspace=$id" --network "$p-browser" --add-host "egress:$bproxy" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /home/browser:rw,nosuid,nodev,mode=1777,size=64m --shm-size 256m --cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges --health-cmd /usr/local/bin/healthcheck.sh --health-interval 5s --health-timeout 3s --health-start-period 30s --cpus 2 --memory 3g --pids-limit 512 -v "$profile:/profile" -v "$files:/workspace" browseruse-browser:local >/dev/null
  "$OCI" run -d --name "$p-utility" --label "browseruse.workspace=$id" --network "$p-utility" --add-host "egress:$uproxy" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --pids-limit 128 -v "$files:/workspace" browseruse-utility:local >/dev/null
  for role in browser utility; do
    pid=$("$OCI" inspect -f '{{.State.Pid}}' "$p-$role")
    proxy=$bproxy; [[ "$role" == utility ]] && proxy=$uproxy
    # Namespace OUTPUT denies DNS, host gateways, all direct IPv4/IPv6,
    # UDP/QUIC/WebRTC and cross-workspace routes, including bridge host IPs.
    for family in iptables ip6tables; do
      ns -t "$pid" -n "$family" -P OUTPUT DROP
      ns -t "$pid" -n "$family" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      ns -t "$pid" -n "$family" -A OUTPUT -o lo -j ACCEPT
      ns -t "$pid" -n "$family" -C OUTPUT -o lo -j ACCEPT
    done
    ns -t "$pid" -n iptables -A OUTPUT -d "$proxy" -p tcp --dport 3128 -j ACCEPT
    ns -t "$pid" -n iptables -C OUTPUT -d "$proxy" -p tcp --dport 3128 -j ACCEPT
  done
  "$OCI" exec "$p-browser" touch /tmp/network-ready
  echo "Private CDP: $p-browser:9223; VNC: $p-browser:5900. Attach only trusted control to $p-browser network."
  ;;
stop)
  for role in browser utility egress; do
    if "$OCI" container inspect "$p-$role" >/dev/null 2>&1; then
      "$OCI" stop -t 30 "$p-$role" >/dev/null
      "$OCI" rm "$p-$role" >/dev/null
    fi
  done
  ;;
delete)
  "$0" stop "$id"
  for vol in "$profile" "$files"; do "$OCI" volume rm "$vol"; done
  for net in browser utility outbound; do "$OCI" network rm "$p-$net"; done
  ;;
inspect) "$OCI" inspect "$p-browser" "$p-utility" "$p-egress" ;;
*) echo 'Unknown operation' >&2; exit 1;;
esac
