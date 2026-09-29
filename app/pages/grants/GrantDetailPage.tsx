import { useState } from "react";
import { useParams, Link } from "wouter";
import { useGrant } from "../../hooks/useGrants";

function rankColor(rank: string | null) {
  switch (rank) {
    case "S":
      return "bg-gradient-to-br from-amber-400 to-amber-500 text-white border-amber-500 shadow-sm font-black";
    case "A":
      return "bg-emerald-100 text-emerald-800 border-emerald-300 font-bold";
    case "B":
      return "bg-sky-100 text-sky-800 border-sky-300 font-semibold";
    case "C":
      return "bg-gray-100 text-gray-500 border-gray-300";
    default:
      return "bg-gray-50 text-gray-400 border-gray-300";
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-300 bg-white p-4 sm:p-5 shadow-sm transition-colors">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-500">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="py-2">
      <dt className="text-xs font-semibold text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-gray-800 whitespace-pre-wrap">{value}</dd>
    </div>
  );
}

function SkeletonDetail() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-pulse">
      <div className="h-4 w-24 rounded bg-gray-200" />
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-8 w-20 rounded-lg bg-gray-200" />
          <div className="h-4 w-16 rounded bg-gray-100" />
        </div>
        <div className="h-6 w-4/5 rounded bg-gray-200" />
        <div className="h-4 w-1/3 rounded bg-gray-100" />
      </div>
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-gray-200 p-5 space-y-3">
          <div className="h-3 w-20 rounded bg-gray-200" />
          <div className="h-4 w-full rounded bg-gray-100" />
          <div className="h-4 w-3/4 rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

export function GrantDetailPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const { data, isLoading } = useGrant(id);
  const [showRaw, setShowRaw] = useState(false);

  if (isLoading) {
    return <SkeletonDetail />;
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl flex flex-col items-center gap-3 py-20">
        <span className="text-4xl text-gray-300">&#128533;</span>
        <p className="text-sm text-gray-500">補助金が見つかりません</p>
        <Link href="/grants" className="mt-2 cursor-pointer text-sm text-indigo-600 transition-colors hover:text-indigo-500">
          ← 一覧に戻る
        </Link>
      </div>
    );
  }

  const a = data.analysis;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Back link */}
      <Link href="/grants" className="inline-flex cursor-pointer items-center gap-1 text-sm text-indigo-600 transition-all duration-200 hover:text-indigo-500 hover:gap-1.5">
        <span aria-hidden="true">←</span> 一覧に戻る
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {a?.taraFitRank && (
            <span className={`inline-flex items-center rounded-lg border px-3 py-1 text-sm font-bold ${rankColor(a.taraFitRank)}`}>
              ランク {a.taraFitRank}
              {a.taraFitScore != null && (
                <span className="ml-1.5 text-xs font-normal opacity-75">({a.taraFitScore}点)</span>
              )}
            </span>
          )}
          <span className="text-sm font-medium text-gray-600">{data.sourceMinistry}</span>
        </div>
        <h1 className="text-xl font-bold leading-snug text-gray-900 sm:text-2xl">{data.title}</h1>
        <div className="flex flex-wrap gap-3 text-sm font-medium text-gray-600 sm:gap-4">
          {data.deadline && (
            <span className="flex items-center gap-1">
              <span className="text-gray-400" aria-hidden="true">&#128197;</span>
              締切: {data.deadline}
            </span>
          )}
          {data.publishedAt && (
            <span>公開: {data.publishedAt}</span>
          )}
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer text-indigo-600 transition-colors duration-200 hover:text-indigo-500"
          >
            元ページを開く ↗
          </a>
        </div>
      </div>

      {/* Summary */}
      {a?.summaryShort && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 shadow-sm sm:p-5">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-indigo-700">要点サマリー（応募判断用）</h3>
          <p className="text-sm font-medium leading-relaxed text-gray-800">{a.summaryShort}</p>
        </div>
      )}

      {/* Grant details */}
      {a && (
        <Section title="制度の概要">
          <dl className="divide-y divide-gray-200">
            <Field label="支援タイプ" value={a.supportType} />
            <Field label="対象者" value={a.targetEntities} />
            <Field label="補助額上限" value={a.maxAmount} />
            <Field label="補助率" value={a.subsidyRate} />
            <Field label="対象テーマ" value={a.eligibleThemes} />
            <Field label="必要書類" value={a.requiredDocuments} />
            <Field label="備考" value={a.notes} />
          </dl>
        </Section>
      )}

      {/* Tara fit + Department */}
      {(a?.taraFitReason || a?.suggestedDepartment) && (
        <Section title="太良町との適合理由・担当課">
          <dl className="divide-y divide-gray-200">
            {a.suggestedDepartment && (
              <div className="py-2.5">
                <dt className="text-xs font-semibold text-gray-500">役場担当窓口（目安）</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-700 border border-indigo-200">
                    {a.suggestedDepartment}
                  </span>
                  {a.suggestedDepartmentReason && (
                    <span className="text-xs text-gray-600">（{a.suggestedDepartmentReason}）</span>
                  )}
                </dd>
              </div>
            )}
            {a.taraCategories && (
              <div className="py-2.5">
                <dt className="text-xs font-semibold text-gray-500">該当分野</dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {a.taraCategories.split(",").map((c) => (
                    <span key={c} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      {c.trim()}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {a.taraFitReason && (
              <div className="py-2.5">
                <dt className="text-xs font-semibold text-gray-500">適合理由</dt>
                <dd className="mt-1 text-sm leading-relaxed text-gray-800">{a.taraFitReason}</dd>
              </div>
            )}
          </dl>
        </Section>
      )}

      {a?.taraUseCase && (
        <Section title="太良町での活用アイデア">
          <p className="text-sm leading-relaxed text-gray-800">{a.taraUseCase}</p>
        </Section>
      )}

      {/* Raw text */}
      {data.rawText && (
        <div>
          <button
            type="button"
            onClick={() => setShowRaw(!showRaw)}
            className="cursor-pointer text-sm text-gray-500 transition-colors duration-200 hover:text-gray-700"
          >
            {showRaw ? "▼ 原文を閉じる" : "▶ 原文を表示"}
          </button>
          {showRaw && (
            <div className="mt-2 rounded-xl border border-gray-300 bg-gray-50 p-4">
              <pre className="whitespace-pre-wrap text-xs leading-relaxed text-gray-500">
                {data.rawText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
