import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LOOP Creator OS · First Outreach Agent",
  description: "红人首次建联项目、AI 个性化、审批与安全发送工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
