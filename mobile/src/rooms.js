// Projects as rooms: the agents of each project, its summary line, and its squares.
import { View } from 'react-native';
import { byAttention } from './store';
import { useTheme } from './theme';

export function rooms(projects, agents) {
  const out = projects.map((p) => ({ key: p.key, label: p.label, color: p.color }));
  for (const a of agents) if (!out.some((p) => p.key === a.project.key)) out.push(a.project);
  return out.map((p) => ({ ...p, agents: byAttention(agents.filter((a) => a.project.key === p.key)) }))
    .filter((r) => r.agents.length)
    .sort((a, b) => rank(a) - rank(b) || Math.max(...b.agents.map((x) => x.updatedAt)) - Math.max(...a.agents.map((x) => x.updatedAt)));
}
const rank = (r) => (r.agents.some((a) => a.needs) ? 0 : r.agents.some((a) => a.status === 'busy') ? 1 : 2);

export function summary(list) {
  const needs = list.filter((a) => a.needs).length, busy = list.filter((a) => a.status === 'busy' && !a.needs).length;
  const n = `${list.length} agent${list.length === 1 ? '' : 's'}`;
  if (needs) return `${n}, ${needs} need${needs === 1 ? 's' : ''} you`;
  if (busy) return `${n}, ${busy} working`;
  return list.length === 1 ? `${n}, quiet` : `${n}, all quiet`;
}

// one square per agent: outlined needs you, orange working, grey idle
export function Squares({ agents, size = 9 }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
      {agents.map((a) => (
        <View key={a.id} style={a.needs ? { width: size, height: size, borderWidth: 2, borderColor: t.sig }
          : { width: size, height: size, backgroundColor: a.status === 'busy' ? t.sig : t.ink3 }} />
      ))}
    </View>
  );
}
