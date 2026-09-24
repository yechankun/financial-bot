import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCommandJson } from "../src/channels/discord/commands/registerSlashCommands.js";
import { formatDirectEtfView, runDirectEtfQuery } from "../src/gateways/local/etfGateway.js";

test("independent /etf command remains registered without internal provider", () => {
  const names = buildCommandJson([], { internalCommandsEnabled: false }).map((item) => item.name);
  assert.deepEqual(names, ["skills", "etf"]);
  const symbol = buildCommandJson([], { internalCommandsEnabled: false })[1].options
    .find((option) => option.name === "symbol");
  assert.equal(symbol.autocomplete, undefined);
});

test("direct ETF lookup uses the local query and preserves missing versus zero flow", async () => {
  const payload = {
    status: "ok", query: "EXAM", known_at: "2026-09-19T00:00:00Z",
    entity: { share_class: { share_class_id: "class_fixture", name: "Example ETF" } },
    holdings: { snapshot_id: "s1", total_rows: 10001, as_of_date: "2026-09-18",
      disclosure_completeness: "partial" },
    capital_series: { observations: [
      { metric: "shares_outstanding", value: "100", as_of_date: "2026-09-18",
        asset_scope: "share_class" },
      { metric: "net_assets", value: "1000000", as_of_date: "2026-09-18",
        asset_scope: "fund", entity_type: "share_class" },
    ] },
    benchmark_series: { links: [], indexes: [] },
    flows: { results: [{ period_start: "2026-09-17", period_end: "2026-09-18",
      selected_flow: "0", currency: "USD", selected_method: "shares_nav" }] },
  };
  const calls = [];
  const view = await runDirectEtfQuery("EXAM", {
    dataDir: "/tmp/etf-v1", execFileImpl: (bin, args, opts, done) => {
      calls.push({ bin, args, opts });
      done(null, JSON.stringify(payload), "");
    },
  });
  assert.deepEqual(view, payload);
  assert.deepEqual(calls[0].args.slice(-4), ["--query", "EXAM", "--holdings-limit", "5"]);
  const message = formatDirectEtfView(view);
  assert.match(message, /10001행/);
  assert.match(message, /partial/);
  assert.match(message, /순유입·유출: 0 USD/);
  assert.match(message, /순자산: 클래스 범위 자료 없음/);
  assert.doesNotMatch(message, /1000000/);
  assert.match(message, /추적지수: 확인된 연결 없음/);
  const missingFlow = formatDirectEtfView({
    ...payload,
    flows: { results: [{ period_start: "2026-09-17", period_end: "2026-09-18",
      selected_flow: null, selected_method: "none",
      reason_codes: ["aum_scope_mismatch", "action_coverage_unknown"] }] },
  });
  assert.match(missingFlow, /순유입·유출: 계산 불가/);
  assert.match(missingFlow, /클래스 순자산 미확인/);
  assert.doesNotMatch(missingFlow, /, none\)/);
});

test("fund-scope issuer reported flow is shown separately from class flow", () => {
  const message = formatDirectEtfView({
    status: "ok", query: "A200", known_at: "2026-09-24T00:00:00Z",
    entity: { fund: { name: "Example ETF" },
      share_class: { share_class_id: "provisional:asx:class:A200" } },
    capital_series: { observations: [{ metric: "net_creation_amount",
      value: "357650683.00", currency: "AUD", asset_scope: "fund",
      as_of_date: "2026-08-31", period_start: "2026-08-01", period_end: "2026-08-31",
      extensions: { source_authority_tier: "exchange",
        official_definition: "Issuer-disclosed value of units issued and redeemed during the month" } }] },
    flows: { results: [] },
  });
  assert.match(message, /순유입·유출: 계산 결과 없음/);
  assert.match(message, /펀드 월간 공시 유입·유출: 357650683\.00 AUD/);
  assert.match(message, /클래스별 배분 미확인/);
});
