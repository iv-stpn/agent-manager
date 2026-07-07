import { Toaster } from "sonner";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<>
			<div className="flex h-screen overflow-hidden">
				<Sidebar />
				<main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
			</div>
			<Toaster richColors />
		</>
	);
}
