"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Input, ConfirmModal, Toggle } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { useNotificationStore } from "@/store/notificationStore";

function fmtTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString();
}

// "freebuff::openai/gpt-5.6-luna" -> { provider: "freebuff", model: "openai/gpt-5.6-luna" }
// "freebuff::*" -> { provider: "freebuff", model: null }
function parseScope(scope) {
  const sep = String(scope || "").indexOf("::");
  if (sep < 0) return { provider: String(scope || ""), model: null };
  const provider = scope.slice(0, sep);
  const model = scope.slice(sep + 2);
  return { provider, model: model === "*" || model === "" ? null : model };
}

function maskProxyUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "";
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${host}${port}`;
  } catch {
    return String(url || "");
  }
}

// Flatten fitness snapshot into one record per (pool, scope); drops expired marks.
function buildRecords(fitness, pools, now = Date.now()) {
  const poolById = new Map((pools || []).map((p) => [p.id, p]));
  const records = [];
  for (const [poolId, byScope] of Object.entries(fitness || {})) {
    const pool = poolById.get(poolId);
    for (const [scope, info] of Object.entries(byScope || {})) {
      const until = info?.until ? new Date(info.until).getTime() : 0;
      if (!until || until <= now) continue;
      const { provider, model } = parseScope(scope);
      records.push({
        poolId,
        scope,
        provider,
        model,
        until,
        reason: info?.reason || "blocked",
        poolName: pool?.name || poolId.slice(0, 8),
        proxyUrl: pool?.proxyUrl || "",
        egress: pool?.egress || null,
      });
    }
  }
  return records;
}

export default function ProxyFitnessPage() {
  const [pools, setPools] = useState([]);
  const [fitness, setFitness] = useState({});
  const [loading, setLoading] = useState(true);
  const [providerFilter, setProviderFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerMenuDropUp, setProviderMenuDropUp] = useState(false);
  const [clearingScope, setClearingScope] = useState(null); // poolId::scope while clearing
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [geoEnabled, setGeoEnabled] = useState(true);
  const [geoUpdating, setGeoUpdating] = useState(false);
  const providerMenuRef = useRef(null);
  const notify = useNotificationStore();

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (providerMenuRef.current && !providerMenuRef.current.contains(e.target)) {
        setProviderMenuOpen(false);
      }
    };
    if (providerMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [providerMenuOpen]);

  const fetchAll = useCallback(async () => {
    try {
      const [poolRes, fitRes] = await Promise.all([
        fetch("/api/proxy-pools?includeUsage=true", { cache: "no-store" }),
        fetch("/api/proxy-pools/fitness", { cache: "no-store" }),
      ]);
      const poolData = await poolRes.json().catch(() => ({ proxyPools: [] }));
      setPools(poolData.proxyPools || []);
      if (fitRes.ok) {
        const fitData = await fitRes.json().catch(() => ({}));
        setFitness(fitData.pools || fitData.fitness || {});
      } else {
        setFitness({});
      }
    } catch (error) {
      console.log("Error fetching proxy fitness:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => {
        if (typeof s.poolGeoProbeEnabled === "boolean") setGeoEnabled(s.poolGeoProbeEnabled);
      })
      .catch(() => {});
  }, []);

  const handleGeoToggle = async (next) => {
    setGeoUpdating(true);
    setGeoEnabled(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poolGeoProbeEnabled: next }),
      });
      if (!res.ok) {
        setGeoEnabled(!next);
        throw new Error(`HTTP ${res.status}`);
      }
      notify.success(next ? "Geo probe enabled" : "Geo probe disabled");
    } catch (err) {
      notify.error(`Update failed: ${err.message}`);
    } finally {
      setGeoUpdating(false);
    }
  };

  const records = useMemo(() => buildRecords(fitness, pools), [fitness, pools]);

  // Providers present in the fitness data (filter options)
  const providerOptions = useMemo(() => {
    const set = new Set();
    for (const rec of records) {
      if (rec.provider) set.add(rec.provider);
    }
    return Array.from(set).sort();
  }, [records]);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((rec) => {
      if (providerFilter !== "all" && rec.provider !== providerFilter) return false;
      if (q) {
        const hay = [rec.proxyUrl, rec.egress?.ip, rec.egress?.country, rec.egress?.region, rec.poolName]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [records, providerFilter, search]);

  const handleClear = async (rec) => {
    setClearingScope(rec.scope);
    try {
      const res = await fetch(`/api/proxy-pools/${rec.poolId}/fitness/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: rec.scope }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notify.success(`Cleared ${rec.scope}`);
      fetchAll();
    } catch (err) {
      notify.error(`Clear failed: ${err.message}`);
    } finally {
      setClearingScope(null);
    }
  };

  const handleClearAll = async () => {
    setClearingAll(true);
    try {
      const res = await fetch("/api/proxy-pools/fitness/clear-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(providerFilter !== "all" ? { provider: providerFilter } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notify.success(providerFilter !== "all" ? `Cleared all ${providerFilter} blocks` : "Cleared all blocks");
      setConfirmClearAll(false);
      fetchAll();
    } catch (err) {
      notify.error(`Clear all failed: ${err.message}`);
    } finally {
      setClearingAll(false);
    }
  };

  const selectedProviderLabel = providerFilter === "all" ? "All providers" : providerFilter;

  // Open the provider menu as an overlay anchored to its container. Flips to
  // drop-up when there isn't enough viewport space below (menu max-h ~288px).
  const toggleProviderMenu = () => {
    if (providerMenuOpen) {
      setProviderMenuOpen(false);
      return;
    }
    const el = providerMenuRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setProviderMenuDropUp(window.innerHeight - rect.bottom < 300);
    }
    setProviderMenuOpen(true);
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      {loading ? (
        <CardSkeleton />
      ) : (
        <>
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-text-main">Proxy Fitness</h1>
              <Badge variant={records.length > 0 ? "error" : "default"} size="sm">
                {records.length} active block{records.length === 1 ? "" : "s"}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {records.length > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  icon="delete_sweep"
                  onClick={() => setConfirmClearAll(true)}
                  disabled={clearingAll}
                >
                  Clear All{providerFilter !== "all" ? ` (${providerFilter})` : ""}
                </Button>
              )}
              <Toggle
                size="sm"
                checked={geoEnabled}
                onChange={handleGeoToggle}
                disabled={geoUpdating}
                label="Geo probe"
                description="Probe egress IP/country per pool every ~30 min (uses geo-API quota)"
              />
              <Button variant="secondary" size="sm" icon="refresh" onClick={fetchAll}>Refresh</Button>
            </div>
          </div>

          <p className="text-sm text-text-muted">
            Shows which provider is blocked on which proxy IP (from provider region gates, per-IP
            limits, or manual marks). Smart rotation skips these pools while the block is active.
          </p>

          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border-subtle bg-surface p-3">
            <div className="relative flex w-64 max-w-full flex-col" ref={providerMenuRef}>
              <label className="mb-1 text-xs font-medium text-text-muted">Provider</label>
              <button
                type="button"
                onClick={toggleProviderMenu}
                className="flex h-8 w-full items-center justify-between gap-1 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-main transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-haspopup="menu"
                aria-expanded={providerMenuOpen}
                title="Filter by provider"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {providerFilter === "all" ? (
                    <span className="material-symbols-outlined text-[14px] text-text-muted">apps</span>
                  ) : (
                    <ProviderIcon providerId={providerFilter} size={18} className="size-[18px] rounded object-contain" fallbackText={providerFilter.slice(0, 2).toUpperCase()} />
                  )}
                  <span className="truncate capitalize">{selectedProviderLabel}</span>
                </span>
                <span className="material-symbols-outlined text-[14px] text-text-muted">expand_more</span>
              </button>

              {providerMenuOpen && (
                <div className={`absolute left-0 z-20 w-full max-h-72 overflow-y-auto rounded-lg border border-border-subtle bg-surface p-1 shadow-lg ${providerMenuDropUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
                  <button
                    type="button"
                    onClick={() => { setProviderFilter("all"); setProviderMenuOpen(false); }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === "all" ? "bg-primary/10 text-primary" : "text-text-main hover:bg-black/5 dark:hover:bg-white/10"}`}
                  >
                    <span className="material-symbols-outlined text-[22px]">apps</span>
                    <span className="font-medium">All providers</span>
                    {providerFilter === "all" && <span className="material-symbols-outlined ml-auto text-[20px]">check</span>}
                  </button>
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  {providerOptions.map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => { setProviderFilter(provider); setProviderMenuOpen(false); }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === provider ? "bg-primary/10 text-primary" : "text-text-main hover:bg-black/5 dark:hover:bg-white/10"}`}
                    >
                      <ProviderIcon providerId={provider} size={24} className="size-6 rounded-md object-contain" fallbackText={provider.slice(0, 2).toUpperCase()} />
                      <span className="font-medium capitalize">{provider}</span>
                      {providerFilter === provider && <span className="material-symbols-outlined ml-auto text-[20px]">check</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex min-w-48 flex-1 flex-col">
              <label className="mb-1 text-xs font-medium text-text-muted">IP / Proxy / Pool</label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g. 104.28, vercel-relay…"
                icon="search"
              />
            </div>
          </div>

          {/* Records table */}
          <Card className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wider text-text-muted">
                    <th className="px-4 py-2 font-semibold">Provider</th>
                    <th className="px-4 py-2 font-semibold">Model</th>
                    <th className="px-4 py-2 font-semibold">IP / Proxy</th>
                    <th className="px-4 py-2 font-semibold">Pool</th>
                    <th className="px-4 py-2 font-semibold">Reason</th>
                    <th className="px-4 py-2 font-semibold">Until</th>
                    <th className="px-4 py-2 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecords.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-text-muted">
                        {records.length === 0
                          ? "No active blocks. Blocks appear here when a provider region-gates a proxy IP."
                          : "No blocks match the current filters."}
                      </td>
                    </tr>
                  ) : (
                    filteredRecords.map((rec) => (
                      <tr key={`${rec.poolId}::${rec.scope}`} className="border-b border-border-subtle last:border-0 align-top hover:bg-surface-2/40">
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-2 rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                            <span className="material-symbols-outlined text-[14px]">block</span>
                            <span className="capitalize">{rec.provider}</span>
                          </span>
                        </td>
                        <td className="max-w-56 px-4 py-3">
                          <span className="truncate text-text-main">{rec.model || <em className="text-text-muted">all models</em>}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <code className="truncate font-mono text-xs text-text-main">{maskProxyUrl(rec.proxyUrl)}</code>
                            {rec.egress?.ip && (
                              <span className="flex items-center gap-1 text-[11px] text-text-muted">
                                <span className="truncate">egress {rec.egress.ip}{rec.egress.country ? ` · ${rec.egress.country}` : ""}</span>
                                {rec.egress.isUnstable && (
                                  <span
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                                    title={rec.egress.ipCount >= 2 ? `Egress IP changed ${rec.egress.ipCount}× — relay egress is not stable` : "Egress is unstable"}
                                  >
                                    unstable
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-text-muted">{rec.poolName}</td>
                        <td className="px-4 py-3 text-text-muted">{rec.reason}</td>
                        <td className="px-4 py-3 text-text-muted">{fmtTime(rec.until)}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              icon="close"
                              onClick={() => handleClear(rec)}
                              disabled={clearingScope === rec.scope}
                              title="Clear this block"
                            >
                              {clearingScope === rec.scope ? "Clearing..." : "Clear"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <ConfirmModal
        isOpen={confirmClearAll}
        onClose={() => setConfirmClearAll(false)}
        onConfirm={handleClearAll}
        title="Clear all blocks"
        message={providerFilter !== "all"
          ? `Clear all active blocks for provider "${providerFilter}"? This lets those pools be selected again immediately.`
          : "Clear all active proxy blocks? This lets all pools be selected again immediately."}
        confirmText={clearingAll ? "Clearing..." : "Clear All"}
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}