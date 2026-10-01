// Determines a foreign-key-safe table load order from the ACTUAL SQLite
// schema (via PRAGMA foreign_key_list), rather than a hardcoded list — so if
// a future table/relationship is added, the migration order stays correct
// automatically. Detects cycles explicitly rather than silently disabling
// constraints to route around them.
function listTables(sqliteDb) {
  return sqliteDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all().map(r => r.name);
}

function tableColumns(sqliteDb, table) {
  return sqliteDb.prepare(`PRAGMA table_info(${table})`).all();
}

// One edge per (child -> parent) foreign key. Self-references (e.g. a
// hypothetical table referencing itself) are recorded but never block load
// order, since a row can always be inserted before rows that reference it
// only through a nullable self-FK — none exist in this schema today, but the
// algorithm doesn't assume that.
function foreignKeyEdges(sqliteDb, table) {
  return sqliteDb.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map(fk => ({ from: table, to: fk.table }))
    .filter(e => e.from !== e.to);
}

// Kahn's algorithm. Throws with the exact remaining tables/edges if a cycle
// is detected — never silently drops constraints to force an order.
function topologicalOrder(sqliteDb) {
  const tables = listTables(sqliteDb);
  const edges = tables.flatMap(t => foreignKeyEdges(sqliteDb, t));

  const inDegree = Object.fromEntries(tables.map(t => [t, 0]));
  const dependents = Object.fromEntries(tables.map(t => [t, []])); // parent -> [children that depend on it]
  for (const { from, to } of edges) {
    if (!(to in inDegree)) continue; // FK to a table outside this table set (shouldn't happen here)
    inDegree[from] += 1;
    dependents[to].push(from);
  }

  const queue = tables.filter(t => inDegree[t] === 0).sort(); // sorted for determinism
  const order = [];
  while (queue.length) {
    const t = queue.shift();
    order.push(t);
    for (const child of dependents[t].sort()) {
      inDegree[child] -= 1;
      if (inDegree[child] === 0) queue.push(child);
    }
  }

  if (order.length !== tables.length) {
    const remaining = tables.filter(t => !order.includes(t));
    throw new Error(
      `Cyclic foreign-key dependency detected — cannot compute a safe load order. ` +
      `Tables still blocked: ${remaining.join(', ')}. This schema is not expected to have ` +
      `cycles; refusing to disable constraints to force an order.`
    );
  }
  return order;
}

module.exports = { listTables, tableColumns, foreignKeyEdges, topologicalOrder };
