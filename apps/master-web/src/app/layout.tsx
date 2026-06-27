import type { Metadata } from "next";
import { Funnel_Sans } from "next/font/google";

import "./globals.css";

const funnelSans = Funnel_Sans({ subsets: ["latin"] });

export const metadata: Metadata = {
	title: "Agent Manager",
	description: "Manage multiple agents based on Anthropic API",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<body className={funnelSans.className}>{children}</body>
		</html>
	);
}
