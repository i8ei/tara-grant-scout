import { useState } from "react";
import { useGrantStatus } from "../hooks/useGrants";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function hoursAgo(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

export function AppShell({
  children,
}: {
  children: React.ReactNode;
  navItems?: { label: string; href: string }[];
}) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const { data: status } = useGrantStatus();
  const cronHours = hoursAgo(status?.lastCronAt ?? null);
  const isStale = cronHours == null || cronHours > 26;

  return (
    <div className="flex min-h-dvh flex-col bg-gray-50 text-gray-900">
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="border-t border-gray-200 py-4 text-center text-xs text-gray-400">
        {status && (
          <div className="mb-2">
            {isStale ? (
              <span className="mr-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">
                <span className="text-[10px]">&#9888;</span> データ更新を確認中
              </span>
            ) : (
              <span className="mr-2 inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-green-700">
                正常稼働中
              </span>
            )}
            最終チェック: {formatDateTime(status.lastCronAt)}
            <span className="mx-1.5">·</span>
            {status.lastCronNewCount != null && status.lastCronNewCount > 0
              ? `新着${status.lastCronNewCount}件`
              : "新着なし"}
            <span className="mx-1.5">·</span>
            {status.grants}件収集 / {status.analyzed}件解析済み
          </div>
        )}
        <div>
          <button
            type="button"
            onClick={() => setAboutOpen(!aboutOpen)}
            className="cursor-pointer hover:text-gray-600 transition-colors"
          >
            About {aboutOpen ? "▾" : "▸"}
          </button>
          <span className="mx-2">·</span>
          <span>Built by circulart</span>
        </div>
        {aboutOpen && (
          <div className="mx-auto mt-3 max-w-lg text-left text-xs leading-relaxed text-gray-500">
            <p>
              国（デジタル庁jGrants）および佐賀県の補助金情報を毎日自動取得し、AIが太良町との相性を判定するシステムです。
              太良町の事業者や役場が活用できる制度をS・A・Bランクで一覧表示しています。
            </p>
            <p className="mt-2">
              データは毎朝自動更新されます。掲載情報はAIによる判定のため、正確性は公式サイトでご確認ください。
            </p>
          </div>
        )}
      </footer>
    </div>
  );
}
