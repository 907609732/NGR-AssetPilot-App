import type { Metadata } from "next";
import "./globals.css";

const siteUrl = "https://ngr.lttlt.top";
const description = "NGR AssetPilot（AI资源领航）是面向游戏 UI 团队的 Windows 桌面工作台，提供六种切图命名方式、规范检测、本地 AI 搜图、批量导出、基地提单表、TAPD 周月报与 Bug 媒体整理。";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "NGR AssetPilot｜AI资源领航 - Windows UI 资源与报表工作台",
  description,
  keywords: ["NGR AssetPilot", "AI资源领航", "Windows桌面工具", "UI切图命名", "切图规范检测", "本地AI搜图", "游戏UI", "TAPD周报", "TAPD月报"],
  alternates: {
    canonical: siteUrl,
  },
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
  },
  openGraph: {
    title: "NGR AssetPilot｜AI资源领航",
    description,
    url: siteUrl,
    siteName: "NGR AssetPilot",
    type: "website",
    locale: "zh_CN",
    images: [{ url: siteUrl + "/og.png", width: 1200, height: 630, alt: "NGR AssetPilot｜Windows UI 资源与报表工作台" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "NGR AssetPilot｜AI资源领航",
    description,
    images: [siteUrl + "/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
