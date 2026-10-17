// Fork lineage in Synapse state: recordFork() attaches forkOf/forkQ to the agent with that pid, and
// entries for processes that are gone are dropped on the next write. Runs against the demo agents.
// Run: SYNAPSE_DEMO=1 SYNAPSE_HOME=$(mktemp -d) node app/tests/lineage.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { listAgents, recordFork, FILES } = await import(new URL('../../lib.mjs', import.meta.url));
const agents = listAgents();
const child = agents.find((a) => a.pid), parent = agents.find((a) => a.id !== child.id);
recordFork(999999, parent.id, 'a fork whose process is long gone');
recordFork(child.pid, parent.id, 'why is the build slow?');
const after = listAgents().find((a) => a.id === child.id);
assert.equal(after.forkOf, parent.id, 'forkOf attached by pid');
assert.equal(after.forkQ, 'why is the build slow?');
assert.equal(listAgents().find((a) => a.id === parent.id).forkOf, undefined, 'the parent is not marked');
assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(FILES.lineage, 'utf8'))), [String(child.pid)], 'dead pid pruned on write');
console.log('PASS lineage', path.basename(FILES.lineage));
