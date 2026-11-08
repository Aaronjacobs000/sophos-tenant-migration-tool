// In-memory AI Defense Policy API (Fusion GraphQL) for one tenant, answering
// the tool's operations the way live tenants did on 07/11 and 08/11/2026:
//   - a new policy goes to the top of the order, DISABLED unless created
//     ENABLED, and the list shows it at once; names need not be unique;
//   - sensors on an update replace the whole map, rules and tags replace,
//     baseRule merges and appControlCategoryAction null clears it; tags sent
//     as {} or null are ignored, so tags can't be cleared;
//   - a policy whose Endpoint scope names nobody can't be created ENABLED or
//     turned on, and at least one sensor must be on;
//   - every write raises version, and an update needs the current one.
// GraphQL-layer failures answer HTTP 200 with errors and data null.

const err = (message, path, code = "DOWNSTREAM_SERVICE_ERROR") => ({ body: { errors: [{ message, path: [path], extensions: { code } }], data: null } });

function namesNobody(scope) {
  const s = scope ?? {};
  if (s.type === "EVERYONE") return false;
  return !["users", "user_ids", "group_ids", "groups", "device_ids", "devices", "device_group_ids", "device_groups"].some((k) => Array.isArray(s[k]) && s[k].length);
}

const withPositions = (rules) => (rules ?? []).map((r, i) => ({
  position: i,
  target: { conditions: r.target?.conditions ?? [] },
  action: r.action,
  enforcementMechanismOverride: r.enforcementMechanismOverride ?? null,
  note: r.note ?? null,
  dataControls: r.dataControls ?? null,
}));

const SENSORS = ["endpoint", "firewall", "dns", "browser"];
const sensorMap = (input) => Object.fromEntries(SENSORS.map((n) => [n, input?.[n] ? { enabled: input[n].enabled, scope: input[n].scope ?? {} } : null]));

/**
 * Controls: `policies` (in order; base last), `settings`, `answer` (replace
 * the next mutation's answer: an object, or a function of the request; with
 * `apply: true` beside `response`, the mutation also takes effect), and
 * `refuse` (operation name to the message every such mutation is refused with).
 */
export function fakeAiDefense(fake, tenant, { policies = [], settings = null } = {}) {
  let seq = 0;
  const ctl = { policies: [], settings, answer: null, refuse: new Map() };
  const make = (p) => ({
    tenantId: tenant.tenantId,
    description: null,
    priority: 1000,
    state: "DISABLED",
    enforcementStatus: "INACTIVE",
    origin: "CUSTOM",
    kind: "TENANT",
    partnerPolicyId: null,
    builtInKey: null,
    builtInVersion: null,
    baseRule: { generativeAiCategoryAction: "ALLOW", appControlCategoryAction: null },
    tags: {},
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    version: 1,
    ...p,
    rules: withPositions(p.rules),
    sensors: { endpoint: null, firewall: null, dns: null, browser: null, ...p.sensors },
  });
  ctl.reset = (list, s = ctl.settings) => {
    ctl.policies = list.map(make);
    ctl.settings = s;
  };
  ctl.reset(policies, settings);
  ctl.find = (id) => ctl.policies.find((p) => p.id === id);
  // Ordinary policies in order, then the base policy; ranks follow.
  const ordered = () => {
    const list = [...ctl.policies.filter((p) => p.kind !== "TENANT_BASE"), ...ctl.policies.filter((p) => p.kind === "TENANT_BASE")];
    list.forEach((p, i) => { p.rank = i + 1; });
    ctl.policies = list;
    return list;
  };
  const copy = (p) => structuredClone(p);
  const bump = (p) => { p.version = Number(p.version) + 1; p.updatedAt = new Date().toISOString(); };

  const mutations = {
    MigrationAiDefenseCreatePolicy: ({ input }) => {
      if (!SENSORS.some((n) => input.sensors?.[n]?.enabled)) return err("at least one sensor must be enabled", "createPolicy");
      if (input.state === "ENABLED" && namesNobody(input.sensors?.endpoint?.scope)) {
        return err("invalid input: only the base policy can apply to everyone; scope the Endpoint sensor to specific users or devices", "createPolicy");
      }
      const p = make({
        id: `aid-${tenant.clientId}-${++seq}`,
        name: input.name,
        description: input.description ?? null,
        state: input.state ?? "DISABLED",
        origin: input.builtInKey ? "BUILT_IN" : "CUSTOM",
        builtInKey: input.builtInKey ?? null,
        builtInVersion: input.builtInVersion ?? null,
        baseRule: { generativeAiCategoryAction: input.baseRule?.generativeAiCategoryAction ?? "ALLOW", appControlCategoryAction: input.baseRule?.appControlCategoryAction ?? null },
        tags: input.tags ?? {},
        rules: input.rules,
        sensors: sensorMap(input.sensors),
      });
      ctl.policies.unshift(p);
      ordered();
      return { body: { data: { createPolicy: copy(p) } } };
    },
    MigrationAiDefenseUpdatePolicy: ({ id, input }) => {
      const p = ctl.find(id);
      if (!p) return err("policy not found", "updatePolicy");
      if (p.origin === "PARTNER") return err("partner policies are read-only", "updatePolicy");
      if (String(input.version) !== String(p.version)) return err("version conflict: policy has been modified", "updatePolicy");
      if (input.name !== undefined) p.name = input.name;
      if (input.description !== undefined) p.description = input.description;
      if (input.rules !== undefined) p.rules = withPositions(input.rules);
      if (input.baseRule) {
        if ("generativeAiCategoryAction" in input.baseRule) p.baseRule.generativeAiCategoryAction = input.baseRule.generativeAiCategoryAction;
        if ("appControlCategoryAction" in input.baseRule) p.baseRule.appControlCategoryAction = input.baseRule.appControlCategoryAction;
      }
      if (input.sensors !== undefined) p.sensors = sensorMap(input.sensors);
      if (input.tags && Object.keys(input.tags).length) p.tags = input.tags;
      bump(p);
      return { body: { data: { updatePolicy: copy(p) } } };
    },
    MigrationAiDefenseEnablePolicy: ({ id }) => {
      const p = ctl.find(id);
      if (!p) return err("policy not found", "enablePolicy");
      if (p.kind !== "TENANT_BASE" && namesNobody(p.sensors.endpoint?.scope)) {
        return err("invalid input: only the base policy can apply to everyone; scope the Endpoint sensor to specific users or devices", "enablePolicy");
      }
      p.state = "ENABLED";
      bump(p);
      return { body: { data: { enablePolicy: copy(p) } } };
    },
    MigrationAiDefenseDisablePolicy: ({ id }) => {
      const p = ctl.find(id);
      if (!p) return err("policy not found", "disablePolicy");
      if (p.kind === "TENANT_BASE") return err("the base policy can't be disabled", "disablePolicy");
      p.state = "DISABLED";
      bump(p);
      return { body: { data: { disablePolicy: copy(p) } } };
    },
    MigrationAiDefenseMovePolicy: ({ id, afterId }) => {
      const p = ctl.find(id);
      if (!p) return err("policy not found", "movePolicy");
      if (id === afterId) return err("cannot move a policy after itself", "movePolicy");
      if (afterId && !ctl.find(afterId)) return err("policy not found", "movePolicy");
      ctl.policies = ctl.policies.filter((x) => x.id !== id);
      const at = afterId ? ctl.policies.findIndex((x) => x.id === afterId) + 1 : 0;
      ctl.policies.splice(at, 0, p);
      ordered();
      bump(p);
      return { body: { data: { movePolicy: copy(p) } } };
    },
    MigrationAiDefenseDeletePolicy: ({ id }) => {
      const p = ctl.find(id);
      if (!p) return err("policy not found", "deletePolicy");
      if (p.kind === "TENANT_BASE" || p.origin === "PARTNER") return err("this policy can't be deleted", "deletePolicy");
      ctl.policies = ctl.policies.filter((x) => x.id !== id);
      ordered();
      return { body: { data: { deletePolicy: true } } };
    },
  };

  const handler = (req) => {
    const v = req.variables ?? {};
    if (req.mutation) {
      const run = mutations[req.op];
      if (!run) return { status: 400, body: { errors: [{ message: `fake: no mutation ${req.op}` }] } };
      if (ctl.refuse.has(req.op)) return err(ctl.refuse.get(req.op), req.op);
      if (ctl.answer) {
        const a = ctl.answer;
        ctl.answer = null;
        const out = typeof a === "function" ? a(req) : a;
        if (out?.apply) {
          run(v);
          return out.response;
        }
        return out;
      }
      return run(v);
    }
    switch (req.op) {
      case "MigrationAiDefensePolicies": {
        const all = ordered();
        const start = v.after ? Number(v.after) : 0;
        const page = all.slice(start, start + (v.first ?? 100));
        const end = start + page.length;
        return { body: { data: { policies: { pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null }, policies: page.map(copy) } } } };
      }
      case "MigrationAiDefensePolicy": {
        ordered();
        const p = ctl.find(v.id);
        return p ? { body: { data: { policy: copy(p) } } } : err("policy not found", "policy", "NOT_FOUND");
      }
      case "MigrationAiDefenseSettings":
        return { body: { data: { secureAITenantSettings: ctl.settings } } };
      default:
        return { status: 400, body: { errors: [{ message: `fake: no query ${req.op}` }] } };
    }
  };
  /** Answer the tenant's Fusion calls again, after a test took them away. */
  ctl.register = () => fake.onFusion(tenant, handler);
  ctl.register();
  return ctl;
}
