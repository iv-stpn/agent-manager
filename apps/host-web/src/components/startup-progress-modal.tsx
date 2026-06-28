import { createProgressStream, PROGRESS_STEP_LABELS, type ProgressStep, type ProgressStreamAction } from "@agent-manager/utils";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3100";

interface StartupProgressModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	action: ProgressStreamAction;
	onComplete: (success: boolean) => void;
}

export function StartupProgressModal({ open, onOpenChange, projectId, action, onComplete }: StartupProgressModalProps) {
	const [steps, setSteps] = useState<ProgressStep[]>([]);
	const [done, setDone] = useState(false);
	const [success, setSuccess] = useState(false);
	const logRef = useRef<HTMLPreElement>(null);

	useEffect(() => {
		if (!open || !projectId) return;

		setSteps([]);
		setDone(false);
		setSuccess(false);

		return createProgressStream(API_URL, projectId, action, {
			onProgress(step, status, log) {
				setSteps((prev) => {
					const existing = prev.find((s) => s.id === step);
					if (existing) {
						return prev.map((s) => (s.id === step ? { ...s, status, ...(log != null ? { log } : {}) } : s));
					}
					return [...prev, { id: step, label: PROGRESS_STEP_LABELS[step] || step, status, log }];
				});
			},
			onDelta(step, line) {
				setSteps((prev) => {
					const existing = prev.find((s) => s.id === step);
					if (existing) {
						return prev.map((s) => (s.id === step ? { ...s, log: (s.log ? `${s.log}\n` : "") + line } : s));
					}
					return [...prev, { id: step, label: PROGRESS_STEP_LABELS[step] || step, status: "running", log: line }];
				});
			},
			onComplete(success) {
				setDone(true);
				setSuccess(success);
				onComplete(success);
			},
			onError() {
				setDone(true);
				setSuccess(false);
			},
		});
	}, [open, projectId, action, onComplete]);

	useEffect(() => {
		if (logRef.current) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, []);

	const canClose = done;
	const title = action === "restart" ? "Restarting Project" : action === "stop" ? "Stopping Project" : "Starting Project";

	return (
		<Dialog open={open} onOpenChange={canClose ? onOpenChange : undefined}>
			<DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => !canClose && e.preventDefault()}>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{!done && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
						{done && success && <CheckCircle2 className="w-4 h-4 text-green-600" />}
						{done && !success && <XCircle className="w-4 h-4 text-red-600" />}
						{title}
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-3 mt-2">
					{steps.map((step) => (
						<div key={step.id} className="flex items-start gap-3">
							<div className="mt-0.5">
								{step.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
								{step.status === "done" && <CheckCircle2 className="w-4 h-4 text-green-500" />}
								{step.status === "error" && <XCircle className="w-4 h-4 text-red-500" />}
								{step.status === "pending" && <div className="w-4 h-4 rounded-full border-2 border-gray-300" />}
							</div>
							<div className="flex-1 min-w-0">
								<div className={cn("text-sm font-medium", step.status === "error" ? "text-red-700" : "text-gray-900")}>
									{step.label}
								</div>
								{step.log && (
									<pre
										ref={logRef}
										className={cn(
											"text-xs mt-1 whitespace-pre-wrap break-all max-h-32 overflow-y-auto rounded p-2",
											step.status === "error" ? "bg-red-50 text-red-700" : "bg-gray-50 text-gray-600"
										)}
									>
										{step.log}
									</pre>
								)}
							</div>
						</div>
					))}

					{steps.length === 0 && !done && (
						<div className="flex items-center gap-2 text-sm text-gray-500">
							<Loader2 className="w-4 h-4 animate-spin" />
							Connecting...
						</div>
					)}
				</div>

				{done && (
					<div className="flex justify-end mt-4">
						<Button variant={success ? "default" : "secondary"} onClick={() => onOpenChange(false)}>
							{success ? "Done" : "Close"}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
