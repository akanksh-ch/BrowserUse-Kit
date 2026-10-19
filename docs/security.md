# Security deployment checklist

This checklist does not certify a deployment. The executable acceptance record is authoritative.

## Before exposing the gateway

- Bind the development gateway to loopback. Terminate TLS at a trusted reverse proxy for non-loopback use; reject unexpected Host values and untrusted forwarded headers.
- Use a unique workspace origin and host-only Secure/HttpOnly/SameSite cookies; never share parent-domain cookies. Protect cookie-authenticated mutations against CSRF.
- Bootstrap the administrator once locally. Store salted password hashes and hashed scoped tokens; revoke sessions/tokens on deletion and privilege changes. Check ongoing connections at most five seconds apart.
- Never expose CDP, VNC or the command executor through published host ports or a general-purpose proxy route. The official MCP subprocess is privileged and belongs on the trusted side.
- Deny unknown MCP tools and version mismatches; arbitrary page evaluation is separately permissioned. Do not log page content or tool arguments by default.
- Treat audit-storage failure as a mutation outage, not an excuse to continue without events.

## Workspace isolation

- Use separate browser and utility namespaces and identities. Do not mount host runtime sockets, Chrome profiles, X sockets or control credentials into the utility.
- Only assigned workspace file roots may be shared. Profile ownership is exclusive and must remain so through crashes and lifecycle races.
- Keep Chrome sandboxing enabled. Do not silently relax seccomp, capabilities or no-new-privileges to make startup pass. Document required user namespace kernel settings for the actual runtime.
- Use read-only roots, explicit writable mounts, bounded CPU/RAM/PIDs, command output/duration limits and storage quotas enforced below untrusted commands, not only at the HTTP upload layer.

## Egress

- Proxy settings alone are not security enforcement. The network must block direct IPv4/IPv6 egress, alternate DNS, UDP/QUIC/WebRTC and unapproved protocols.
- Resolve and pin destinations at the policy proxy. Reject private, loopback, link-local, metadata, host and control addresses, including mixed DNS answers, numeric variants and IPv4-mapped IPv6.
- Revalidate every connection and redirect destination. Validate HTTPS CONNECT authorities, ports and WebSocket upgrades.
- Test browser and utility independently. A successful normal HTTPS request does not prove bypass resistance.

## Takeover

- The RFB server-side gate—not noVNC's UI flags—authorizes every keyboard, pointer and clipboard input.
- Handle fragmented and coalesced RFB messages; reject unknown encodings/extensions or malformed oversized input rather than losing parser alignment.
- Require current operator authentication, interactive permission and the active workspace human lease. Deny input immediately when validation fails.
- Revoke agent automation leases before takeover. Settle or cancel in-flight mutations within ten seconds; fail takeover if cancellation cannot be proven. Never replay queued mutations after release.
- Losing a control connection must not leave indefinite control; human leases default to thirty seconds and require renewal. Agent mutation requires fresh automation leases after release.

## Honest limits

Tab ownership does not isolate browser secrets. Screenshots and arbitrary command output may contain secrets despite redaction. Browser profile backups are sensitive and exact live-state restoration is not guaranteed. Physical deletion depends on host storage. Hostile public tenancy, multi-host scheduling and host-loss backup are outside v1.
