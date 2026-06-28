import { Sidebar } from "@/components/sidebar";
import "./globals.css";

export default function Layout({ children }: { children: React.ReactNode }) {
	return (
		<>
			<Sidebar />
			<div className="pl-16">{children}</div>
		</>
	);
}
