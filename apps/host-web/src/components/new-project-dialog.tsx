import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createProject as apiCreateProject, checkWorkspacePath } from "@/lib/agent-api";

interface NewProjectFormValues {
	name: string;
	description: string;
	workspacePath: string;
	anthropicKey: string;
	anthropicBaseUrl: string;
	model: string;
}

const emptyForm: NewProjectFormValues = {
	name: "",
	description: "",
	workspacePath: "",
	anthropicKey: "",
	anthropicBaseUrl: "",
	model: "",
};

type PathWarning = { status: "not_found" | "not_empty" | "not_directory"; path: string } | null;

interface NewProjectFormProps {
	onSuccess?: () => void;
	onCancel?: () => void;
}

export function NewProjectForm({ onSuccess, onCancel }: NewProjectFormProps) {
	const [form, setForm] = useState<NewProjectFormValues>(emptyForm);
	const [pathWarning, setPathWarning] = useState<PathWarning>(null);
	const [loading, setLoading] = useState(false);

	const update = (field: keyof NewProjectFormValues, value: string) => setForm((f) => ({ ...f, [field]: value }));

	async function handleSubmit(skipPathCheck = false) {
		if (!form.name.trim()) return;

		if (form.workspacePath && !skipPathCheck) {
			try {
				const result = await checkWorkspacePath(form.workspacePath);
				if (result.status !== "empty") {
					setPathWarning({ status: result.status, path: result.path });
					return;
				}
			} catch {
				// If check fails, proceed anyway
			}
		}

		setLoading(true);
		try {
			await apiCreateProject({
				name: form.name.trim(),
				description: form.description || undefined,
				workspacePath: form.workspacePath || undefined,
				agent: {
					anthropicApiKey: form.anthropicKey || undefined,
					anthropicBaseUrl: form.anthropicBaseUrl || undefined,
					model: form.model || undefined,
				},
			});
			setForm(emptyForm);
			setPathWarning(null);
			toast.success("Project created");
			onSuccess?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create project");
		} finally {
			setLoading(false);
		}
	}

	if (pathWarning) {
		return (
			<div className="space-y-4">
				{pathWarning.status === "not_found" && (
					<>
						<p className="text-sm text-muted-foreground">
							The folder <code className="bg-muted px-1 rounded">{pathWarning.path}</code> does not exist. Create it?
						</p>
						<div className="flex gap-2">
							<Button
								className="flex-1"
								onClick={() => {
									setPathWarning(null);
									handleSubmit(true);
								}}
							>
								Create folder
							</Button>
							<Button className="flex-1" variant="secondary" onClick={() => setPathWarning(null)}>
								Go back
							</Button>
						</div>
					</>
				)}
				{pathWarning.status === "not_empty" && (
					<>
						<p className="text-sm text-muted-foreground">
							The folder <code className="bg-muted px-1 rounded">{pathWarning.path}</code> is not empty. Use it anyway?
						</p>
						<div className="flex gap-2">
							<Button
								className="flex-1"
								onClick={() => {
									setPathWarning(null);
									handleSubmit(true);
								}}
							>
								Continue
							</Button>
							<Button className="flex-1" variant="secondary" onClick={() => setPathWarning(null)}>
								Go back
							</Button>
						</div>
					</>
				)}
				{pathWarning.status === "not_directory" && (
					<>
						<p className="text-sm text-muted-foreground">
							The path <code className="bg-muted px-1 rounded">{pathWarning.path}</code> is not a directory. Please choose a
							different path.
						</p>
						<Button variant="secondary" onClick={() => setPathWarning(null)}>
							Go back
						</Button>
					</>
				)}
			</div>
		);
	}

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
			className="space-y-4"
		>
			<div className="space-y-2">
				<Label htmlFor="np-name">Project Name</Label>
				<Input
					id="np-name"
					autoFocus
					value={form.name}
					onChange={(e) => update("name", e.target.value)}
					placeholder="My Project"
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="np-desc">Description</Label>
				<Input
					id="np-desc"
					value={form.description}
					onChange={(e) => update("description", e.target.value)}
					placeholder="Optional description"
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="np-path">Workspace Path</Label>
				<Input
					id="np-path"
					value={form.workspacePath}
					onChange={(e) => update("workspacePath", e.target.value)}
					placeholder="/path/to/repo (leave empty for internal)"
				/>
			</div>

			<div className="border-t pt-4 space-y-3">
				<p className="text-sm font-medium">Anthropic</p>
				<Input
					type="password"
					value={form.anthropicKey}
					onChange={(e) => update("anthropicKey", e.target.value)}
					placeholder="ANTHROPIC_API_KEY (sk-ant-...)"
				/>
				<Input
					value={form.anthropicBaseUrl}
					onChange={(e) => update("anthropicBaseUrl", e.target.value)}
					placeholder="Base URL (optional)"
				/>
				<Input
					value={form.model}
					onChange={(e) => update("model", e.target.value)}
					placeholder="Model (optional, e.g. claude-sonnet-4-6)"
				/>
			</div>

			<DialogFooter>
				{onCancel && (
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
				)}
				<Button type="submit" disabled={loading || !form.name.trim()}>
					{loading ? "Creating..." : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}

interface NewProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent open={open} className="sm:max-w-md max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>New Project</DialogTitle>
				</DialogHeader>
				<NewProjectForm onSuccess={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
			</DialogContent>
		</Dialog>
	);
}
