import { useState, useMemo, useCallback } from "react";
import { Link, useSearchParams } from "wouter";
import { useGrants } from "../../hooks/useGrants";

const CATEGORIES = [
  { key: "福祉・医療", label: "福祉・介護・医療", icon: "👵" },
  { key: "農業", label: "みかん・農業", icon: "🍊" },
  { key: "漁業", label: "カニ・海苔・水産", icon: "🦀" },
  { key: "旅館・観光", label: "温泉旅館・観光", icon: "♨️" },
  { key: "小規模事業者", label: "商店・飲食・小規模", icon: "🏪" },
  { key: "インフラ・建設", label: "建設・土木・工事", icon: "🏗️" },
  { key: "林業", label: "林業・木材", icon: "🌲" },
  { key: "デジタル・IT", label: "IT・DX化", icon: "💻" },
  { key: "環境・エネルギー", label: "環境・再エネ", icon: "🌱" },
  { key: "地域振興", label: "役場・地域振興", icon: "🏛️" },
];

const CATEGORY_ICON_MAP: Record<string, string> = {
  "福祉・医療": "👵",
  "農業": "🍊",
  "漁業": "🦀",
  "旅館・観光": "♨️",
  "小規模事業者": "🏪",
  "インフラ・建設": "🏗️",
  "林業": "🌲",
  "デジタル・IT": "💻",
  "環境・エネルギー": "🌱",
  "地域振興": "🏛️",
};

function rankBadge(rank: string | null) {
  switch (rank) {
    case "S":
      return "bg-gradient-to-br from-amber-400 to-amber-500 text-white border-amber-500 font-black shadow-xs";
    case "A":
      return "bg-emerald-100 text-emerald-800 border-emerald-300 font-bold";
    case "B":
      return "bg-sky-100 text-sky-800 border-sky-300 font-semibold";
    case "C":
      return "bg-gray-100 text-gray-500 border-gray-300";
    default:
      return "bg-gray-100 text-gray-400 border-gray-300";
  }
}

function rankRowBorder(rank: string | null) {
  switch (rank) {
    case "S":
      return "border-l-amber-500";
    case "A":
      return "border-l-emerald-500";
    case "B":
      return "border-l-sky-500";
    default:
      return "border-l-transparent";
  }
}

function deadlineInfo(deadline: string | null) {
  if (!deadline) return { text: "未定", urgent: false, ended: false };
  const d = new Date(deadline);
  const now = new Date();
  const diff = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const formatted = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  if (diff < 0) return { text: formatted, urgent: false, ended: true, days: diff };
  if (diff <= 7) return { text: formatted, urgent: true, ended: false, days: diff };
  if (diff <= 30) return { text: formatted, urgent: false, ended: false, days: diff };
  return { text: formatted, urgent: false, ended: false, days: diff };
}

function isNewGrant(createdAt: string): boolean {
  const created = new Date(createdAt).getTime();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return created >= sevenDaysAgo;
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 animate-pulse">
      <div className="h-7 w-7 rounded bg-gray-200" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-3/4 rounded bg-gray-200" />
        <div className="h-3 w-1/2 rounded bg-gray-100" />
      </div>
      <div className="h-4 w-10 rounded bg-gray-100" />
      <div className="h-4 w-16 rounded bg-gray-100" />
    </div>
  );
}

type SortKey = "rank" | "score" | "deadline";

export function GrantListPage() {
  const searchParams = useSearchParams();
  const params = searchParams[0];
  const setParams = searchParams[1];

  // Read initial state from URL
  const category = params.get("category") ?? "";
  const q = params.get("q") ?? "";
  const sortBy = (params.get("sort") as SortKey) || "score";
  const showEnded = params.get("ended") === "1";

  const [searchInput, setSearchInput] = useState(q);

  const [rankInfoOpen, setRankInfoOpen] = useState(false);

  const setFilter = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
      setParams(next);
    },
    [params, setParams],
  );

  const { data: grants = [], isLoading } = useGrants({
    category: category || undefined,
    q: q || undefined,
    includeEnded: showEnded,
  });

  const sorted = useMemo(() => {
    const rankOrder: Record<string, number> = { S: 0, A: 1, B: 2, C: 3 };
    return [...grants].sort((a, b) => {
      if (sortBy === "rank") {
        const ra = rankOrder[a.taraFitRank ?? "C"] ?? 4;
        const rb = rankOrder[b.taraFitRank ?? "C"] ?? 4;
        if (ra !== rb) return ra - rb;
        return (b.taraFitScore ?? 0) - (a.taraFitScore ?? 0);
      }
      if (sortBy === "score") {
        return (b.taraFitScore ?? 0) - (a.taraFitScore ?? 0);
      }
      // deadline
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.localeCompare(b.deadline);
    });
  }, [grants, sortBy]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-900">
          補助金スカウト <span className="text-lg font-normal text-gray-400">@太良</span> <span className="text-base font-normal text-gray-400">— </span><span className="text-indigo-600">{grants.length}</span><span className="text-base font-normal text-gray-400">件</span>
        </h1>
        <p className="text-sm text-gray-500">
          全省庁の補助金からAIが太良町に使えそうなものを自動ピックアップ
        </p>
      </div>

      {/* Category filters */}
      <div className="space-y-2 rounded-xl bg-gray-50/80 p-3 border border-gray-200/80">
        <div className="flex items-center justify-between text-xs text-gray-600 font-medium px-1">
          <span>あなたの業種・立場から探す:</span>
          {category && (
            <button
              onClick={() => setFilter("category", "")}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 cursor-pointer"
            >
              ✕ 条件を解除
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 sm:gap-2">
          <button
            onClick={() => setFilter("category", "")}
            className={`cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 ${!category ? "bg-indigo-600 text-white shadow-sm" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-100 hover:text-gray-900"}`}
          >
            全業種
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setFilter("category", category === cat.key ? "" : cat.key)}
              className={`cursor-pointer rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 flex items-center gap-1.5 ${category === cat.key ? "bg-indigo-600 text-white shadow-sm" : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-100 hover:text-gray-900"}`}
            >
              <span aria-hidden="true">{cat.icon}</span>
              <span>{cat.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Search & sort */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter("q", searchInput);
          }}
        >
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="キーワード検索..."
            className="w-40 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 transition-colors hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:w-48"
          />
          <button
            type="submit"
            className="cursor-pointer rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-indigo-500 active:scale-95"
          >
            検索
          </button>
        </form>

        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-gray-600 sm:gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-gray-900">
            <input
              type="checkbox"
              checked={showEnded}
              onChange={(e) => setFilter("ended", e.target.checked ? "1" : "")}
              className="cursor-pointer rounded border-gray-300 bg-white text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0"
            />
            終了分も表示
          </label>
          <span className="hidden text-gray-300 sm:inline">|</span>
          <div className="flex items-center gap-1">
            <span className="hidden sm:inline">並び順:</span>
            {(["score", "rank", "deadline"] as SortKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setFilter("sort", key === "score" ? "" : key)}
                className={`cursor-pointer rounded px-2 py-1 transition-all duration-200 ${sortBy === key ? "bg-gray-900 text-white" : "hover:bg-gray-200 hover:text-gray-900"}`}
              >
                {key === "score" ? "スコア" : key === "rank" ? "ランク" : "締切"}
              </button>
            ))}
          </div>
          <span className="hidden text-gray-300 sm:inline">|</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setRankInfoOpen(!rankInfoOpen)}
              className="cursor-pointer rounded px-1.5 py-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-all"
              title="ランクの基準"
            >
              ?
            </button>
            {rankInfoOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setRankInfoOpen(false)} />
                <div className="absolute right-0 top-7 z-50 w-64 rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-600 shadow-lg">
                  <p className="mb-2 font-semibold text-gray-800">AIランクの基準</p>
                  <div className="space-y-1.5">
                    <p><span className="inline-flex h-5 w-5 items-center justify-center rounded bg-gradient-to-br from-amber-400 to-amber-500 text-[10px] font-black text-white">S</span> 【超特選】太良町基幹産業に直結（80点〜）</p>
                    <p><span className="inline-flex h-5 w-5 items-center justify-center rounded bg-emerald-100 text-[10px] font-bold text-emerald-800">A</span> 【積極推奨】町内事業者の本命制度（60〜79点）</p>
                    <p><span className="inline-flex h-5 w-5 items-center justify-center rounded bg-sky-100 text-[10px] font-bold text-sky-800">B</span> 【条件付き】共同申請・要件次第で検討（45〜59点）</p>
                    <p><span className="inline-flex h-5 w-5 items-center justify-center rounded bg-gray-100 text-[10px] font-bold text-gray-500">C</span> 太良町には不適・対象外（44点以下）</p>
                  </div>
                  <p className="mt-2 text-[10px] text-gray-400">スコアはAIが総合的に判定した太良町への適合度（0〜100）</p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16">
          <span className="text-3xl text-gray-300">&#128269;</span>
          <p className="text-sm text-gray-600">該当する補助金がありません</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {/* Rows */}
          <div className="divide-y divide-gray-200">
            {sorted.map((g) => {
              const dl = deadlineInfo(g.deadline);
              const isNew = isNewGrant(g.createdAt);
              return (
                <Link
                  key={g.id}
                  href={`/grants/${g.id}`}
                  className={`group flex cursor-pointer items-start gap-3 border-l-3 px-4 py-3.5 transition-all duration-200 hover:bg-indigo-50/50 sm:items-center ${rankRowBorder(g.taraFitRank)} ${dl.ended ? "opacity-50" : ""}`}
                >
                  {/* Rank badge */}
                  <span className="flex shrink-0 items-center pt-0.5 sm:pt-0">
                    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold border transition-transform duration-200 group-hover:scale-110 ${rankBadge(g.taraFitRank)}`}>
                      {g.taraFitRank ?? "—"}
                    </span>
                  </span>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-snug text-gray-900 group-hover:text-indigo-700 transition-colors duration-200 sm:truncate">
                      {isNew && (
                        <span className="mr-1.5 inline-flex items-center rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white align-text-top">NEW</span>
                      )}
                      {g.title}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
                      <span className="font-medium">{g.sourceMinistry}</span>
                      {g.suggestedDepartment && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">{g.suggestedDepartment}</span>
                        </>
                      )}
                      {g.targetEntities && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                            {g.targetEntities.includes("民間") ? "民間事業者" : g.targetEntities.includes("役場") ? "役場向け" : g.targetEntities.slice(0, 10)}
                          </span>
                        </>
                      )}
                      {g.taraCategories && (
                        <>
                          <span className="text-gray-300">·</span>
                          {g.taraCategories.split(",").slice(0, 2).map((c) => {
                            const trimmed = c.trim();
                            const icon = CATEGORY_ICON_MAP[trimmed] || "🏷️";
                            return (
                              <span key={trimmed} className="inline-flex items-center gap-0.5 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                                <span aria-hidden="true">{icon}</span>
                                <span>{trimmed}</span>
                              </span>
                            );
                          })}
                        </>
                      )}
                      {g.maxAmount && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className="font-semibold text-emerald-700">{g.maxAmount}</span>
                        </>
                      )}
                    </div>
                    {g.summaryShort && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500 sm:line-clamp-1">
                        {g.summaryShort}
                      </p>
                    )}
                  </div>

                  {/* Score & Deadline — right side */}
                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                    {g.taraFitScore != null && (
                      <span className="tabular-nums font-bold text-gray-800">{g.taraFitScore}<span className="font-normal text-gray-500">点</span></span>
                    )}
                    {dl.text !== "未定" && (
                      <span className={dl.ended ? "text-gray-400 line-through" : dl.urgent ? "font-semibold text-red-600" : "text-gray-500"}>
                        {dl.ended ? "終了" : dl.days != null && dl.days <= 30 ? `残${dl.days}日` : `〜${dl.text}`}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
