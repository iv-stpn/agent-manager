import {
	Archive,
	Brain,
	Clock,
	FileOutput,
	FilePen,
	FilePlus,
	FileText,
	Folder,
	FolderPlus,
	GitCommitHorizontal,
	HelpCircle,
	Info,
	ListPlus,
	type LucideIcon,
	Minimize2,
	Octagon,
	Pencil,
	Save,
	Search,
	Send,
	Snowflake,
	Sparkles,
	Tag,
	Terminal,
	Timer,
	Trash2,
	Wrench,
} from "lucide-react";

export interface ToolIconSpec {
	Icon: LucideIcon;
	/** Tailwind classes for the colored box the icon sits in. */
	box: string;
}

// Maps a tool name to a type-specific icon inside a category-colored box.
// Categories share a hue so related tools read as a group at a glance.
const TOOL_ICONS: Record<string, ToolIconSpec> = {
	// Shell
	bash: { Icon: Terminal, box: "bg-orange-500/10 text-orange-500" },

	// Filesystem — blue/cyan/green/red by intent
	read_file: { Icon: FileText, box: "bg-blue-500/10 text-blue-500" },
	read_file_range: { Icon: FileText, box: "bg-blue-500/10 text-blue-500" },
	write_file: { Icon: FilePlus, box: "bg-green-500/10 text-green-500" },
	edit_file: { Icon: FilePen, box: "bg-green-500/10 text-green-500" },
	list_directory: { Icon: Folder, box: "bg-cyan-500/10 text-cyan-500" },
	create_directory: { Icon: FolderPlus, box: "bg-cyan-500/10 text-cyan-500" },
	search_files: { Icon: Search, box: "bg-cyan-500/10 text-cyan-500" },
	get_file_info: { Icon: Info, box: "bg-cyan-500/10 text-cyan-500" },
	move_file: { Icon: FileOutput, box: "bg-slate-500/10 text-slate-500" },
	delete_file: { Icon: Trash2, box: "bg-red-500/10 text-red-500" },

	// Memory — purple
	read_memory: { Icon: Brain, box: "bg-purple-500/10 text-purple-500" },
	write_memory: { Icon: Save, box: "bg-purple-500/10 text-purple-500" },
	search_memory: { Icon: Search, box: "bg-purple-500/10 text-purple-500" },
	append_decision: { Icon: ListPlus, box: "bg-amber-500/10 text-amber-500" },

	// Questions / reports
	queue_question: { Icon: HelpCircle, box: "bg-purple-500/10 text-purple-500" },
	ask_user_question: { Icon: HelpCircle, box: "bg-amber-500/10 text-amber-500" },
	send_report: { Icon: Send, box: "bg-indigo-500/10 text-indigo-500" },

	// Session config — slate
	change_timeout: { Icon: Clock, box: "bg-slate-500/10 text-slate-500" },
	change_report_time_interval: { Icon: Timer, box: "bg-slate-500/10 text-slate-500" },
	change_freeze_report_mode: { Icon: Snowflake, box: "bg-sky-500/10 text-sky-500" },
	change_freeze_ask_mode: { Icon: Snowflake, box: "bg-sky-500/10 text-sky-500" },
	compact_context: { Icon: Minimize2, box: "bg-slate-500/10 text-slate-500" },
	change_compact_threshold: { Icon: Archive, box: "bg-slate-500/10 text-slate-500" },
	change_stop_threshold: { Icon: Octagon, box: "bg-slate-500/10 text-slate-500" },
	change_always_improve_mode: { Icon: Sparkles, box: "bg-pink-500/10 text-pink-500" },
	set_session_name: { Icon: Tag, box: "bg-slate-500/10 text-slate-500" },

	// Git
	commit_changes: { Icon: GitCommitHorizontal, box: "bg-emerald-500/10 text-emerald-500" },

	// edit_file alias kept for safety
	pencil: { Icon: Pencil, box: "bg-green-500/10 text-green-500" },
};

const DEFAULT_TOOL_ICON: ToolIconSpec = {
	Icon: Wrench,
	box: "bg-slate-500/10 text-slate-500",
};

export function toolIcon(name: string): ToolIconSpec {
	return TOOL_ICONS[name] ?? DEFAULT_TOOL_ICON;
}

/** Renders the tool-type icon inside its colored box. */
export function ToolIconBox({ name, className }: { name: string; className?: string }) {
	const { Icon, box } = toolIcon(name);
	return (
		<span className={`inline-flex shrink-0 items-center justify-center rounded ${box} ${className ?? ""}`}>
			<Icon className="h-3 w-3" />
		</span>
	);
}
