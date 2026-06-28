import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

export function BackLink({ href, label }: { href: string; label: string }) {
	return (
		<div className="flex items-center gap-3 mb-3">
			<Link to={href} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
				<ArrowLeft className="w-4 h-4" />
				{label}
			</Link>
		</div>
	);
}
