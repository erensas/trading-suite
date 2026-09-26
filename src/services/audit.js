// suite_audit_log (db/migrations/004): who changed settings, providers and instruments.
// A failed insert is logged and does not fail the change itself.
function createAudit({ db, identity, log }) {
  return async function audit(req, action, entity, entityId, before, after) {
    const actor = identity.actorLabel(req);
    try {
      await db.query(
        'INSERT INTO suite_audit_log (actor, action, entity, entity_id, before, after) VALUES ($1, $2, $3, $4, $5, $6)',
        [actor, action, entity, entityId === null || entityId === undefined ? null : String(entityId), before, after]
      );
    } catch (e) {
      (req.log || log).error({ action, entity, entityId, actor, error: e.message }, 'audit entry not stored');
    }
  };
}

module.exports = { createAudit };
