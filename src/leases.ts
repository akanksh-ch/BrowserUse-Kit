import { randomUUID } from 'node:crypto';

export interface Principal { workspaceId: string; connectionId: string; subject: string; permissions: readonly string[]; reconnectId: string }
export type Audit = (workspace: string, type: string, source: string, summary: string) => void;
export interface Lease { id: string; connectionId: string; expiresAt: number }
interface State { automation: Map<string, Lease>; human?: Lease; pending: boolean; active: Set<() => Promise<void>> }
/** Callbacks must revalidate expiry/revocation against the authoritative credential store. */
export class LeaseManager {
  private states = new Map<string, State>();
  constructor(private audit: Audit, private validate: (p: Principal) => void, private now = () => performance.now()) {}
  private state(w: string): State { let s = this.states.get(w); if (!s) this.states.set(w, s = { automation: new Map(), pending: false, active: new Set() }); return s; }
  private check(p: Principal, permission: string) { this.validate(p); if (!p.permissions.includes(permission)) throw new Error('Permission denied'); }
  private expire(p: Principal, s: State) {
    if (s.human && s.human.expiresAt <= this.now()) { this.audit(p.workspaceId, 'lease.expired', s.human.connectionId, 'human'); s.human = undefined; }
    for (const [id, l] of s.automation) if (l.expiresAt <= this.now()) { this.audit(p.workspaceId, 'lease.expired', id, 'automation'); s.automation.delete(id); }
  }
  acquireAutomation(p: Principal): Lease {
    this.check(p, 'automation'); const s = this.state(p.workspaceId); this.expire(p, s);
    if (s.pending || s.human) { this.audit(p.workspaceId, 'lease.contention', p.connectionId, 'human control'); throw new Error('Human control pending or active'); }
    const l = { id: randomUUID(), connectionId: p.connectionId, expiresAt: this.now() + 60_000 };
    this.audit(p.workspaceId, 'lease.acquired', p.connectionId, 'automation'); s.automation.set(p.connectionId, l); return { ...l };
  }
  renewAutomation(p: Principal, id: string): Lease { this.assertAutomation(p); const l = this.state(p.workspaceId).automation.get(p.connectionId)!; if (l.id !== id) throw new Error('Lease mismatch'); this.audit(p.workspaceId, 'lease.renewed', p.connectionId, 'automation'); l.expiresAt = this.now() + 60_000; return { ...l }; }
  assertAutomation(p: Principal) { this.validate(p); const s = this.state(p.workspaceId); this.expire(p, s); if (s.pending || s.human || !s.automation.has(p.connectionId)) throw new Error('Automation lease required'); }
  beginMutation(p: Principal, cancel: () => Promise<void>): () => void { this.assertAutomation(p); const s = this.state(p.workspaceId); s.active.add(cancel); return () => { s.active.delete(cancel); }; }
  async acquireHuman(p: Principal): Promise<Lease> {
    this.check(p, 'takeover'); const s = this.state(p.workspaceId); this.expire(p, s); if (s.pending || s.human) throw new Error('Control already held');
    this.audit(p.workspaceId, 'lease.preemption', p.connectionId, 'automation revoked'); s.pending = true; s.automation.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([...s.active].map(cancel => cancel())), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Takeover cancellation timed out')), 10_000); })]);
      // Cancellation callbacks must resolve only after their operation has settled.
      this.check(p, 'takeover');
      const l = { id: randomUUID(), connectionId: p.connectionId, expiresAt: this.now() + 30_000 };
      this.audit(p.workspaceId, 'lease.acquired', p.connectionId, 'human'); s.human = l; return { ...l };
    } finally { clearTimeout(timer); s.pending = false; }
  }
  assertHuman(p: Principal) { this.check(p, 'takeover'); const s = this.state(p.workspaceId); this.expire(p, s); if (s.pending || !s.human || s.human.connectionId !== p.connectionId) throw new Error('Human lease required'); }
  renewHuman(p: Principal, id: string): Lease { this.assertHuman(p); const l = this.state(p.workspaceId).human!; if (l.id !== id) throw new Error('Lease mismatch'); this.audit(p.workspaceId, 'lease.renewed', p.connectionId, 'human'); l.expiresAt = this.now() + 30_000; return { ...l }; }
  release(p: Principal) { this.validate(p); const s = this.state(p.workspaceId); this.audit(p.workspaceId, 'lease.revoked', p.connectionId, 'all connection leases'); s.automation.delete(p.connectionId); if (s.human?.connectionId === p.connectionId) s.human = undefined; }
}
