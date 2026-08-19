import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const socialImage = `${protocol}://${host}/og.png`;

  return {
    metadataBase: new URL("https://ngr.lttlt.top"),
    title: "NGR AssetPilot V3｜AI资源领航 - Windows 游戏 UI 资源工作台",
    description: "面向 Windows 10/11 的本地桌面工作台，集 AI 命名、团队知识库、UI 切图规范检测、迁移备份和批量导出于一体。",
    keywords: ["NGR AssetPilot", "AI资源领航", "Windows桌面软件", "UI切图命名", "资源规范检测", "游戏UI"],
    icons: {
      icon: "/favicon.png",
      shortcut: "/favicon.png",
    },
    alternates: {
      canonical: "https://ngr.lttlt.top",
    },
    openGraph: {
      title: "NGR AssetPilot V3｜AI资源领航 Windows 桌面版",
      description: "让每一张 UI 资源，驶向正确的名字。前往官方短域名下载已通过安全验收的 Windows 桌面版。",
      type: "website",
      locale: "zh_CN",
      images: [{ url: socialImage, width: 1200, height: 630, alt: "NGR AssetPilot｜AI资源领航" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "NGR AssetPilot V3｜AI资源领航",
      description: "Windows 游戏 UI 资源智能工作台。",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
