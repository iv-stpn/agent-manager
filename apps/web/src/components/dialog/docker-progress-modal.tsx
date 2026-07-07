import {
	createProgressStream,
	PROGRESS_STEP_LABELS,
	type ProgressStep,
	type ProgressStreamAction,
	updateOrAppendById,
} from "@agent-manager/utils";
import { CheckCircle2, Loader2, Square, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { API_URL } from "@/constants";
import { orchestratorApiToken } from "@/lib/auth";
import { cn } from "@/lib/utils";

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
	const [stopping, setStopping] = useState(false);
	const onCompleteRef = useRef(onComplete);
	onCompleteRef.current = onComplete;
	const cancelRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		if (!open || !projectId) return;

		setSteps([]);
		setDone(false);
		setSuccess(false);
		setStopping(false);

		const cancel = createProgressStream(
			API_URL,
			projectId,
			action,
			{
				onProgress(step, status, log) {
					setSteps((previous) =>
						updateOrAppendById<ProgressStep>(
							previous,
							step,
							(step) => ({ ...step, status, ...(log != null ? { log } : {}) }),
							() => ({ id: step, label: PROGRESS_STEP_LABELS[step] || step, status, log })
						)
					);
				},
				onDelta(step, line) {
					setSteps((prev) =>
						updateOrAppendById<ProgressStep>(
							prev,
							step,
							(step) => ({ ...step, log: (step.log ? `${step.log}\n` : "") + line }),
							() => ({ id: step, label: PROGRESS_STEP_LABELS[step] || step, status: "running", log: line })
						)
					);
				},
				onComplete(success) {
					cancelRef.current = null;
					setDone(true);
					setSuccess(success);
					onCompleteRef.current(success);
				},
				onError() {
					cancelRef.current = null;
					setDone(true);
					setSuccess(false);
				},
			},
			orchestratorApiToken
		);
		cancelRef.current = cancel;
		return () => {
			cancel();
			cancelRef.current = null;
		};
	}, [open, projectId, action]);

	function handleStop() {
		setStopping(true);
		cancelRef.current?.();
		cancelRef.current = null;
		setDone(true);
		setSuccess(false);
		setStopping(false);
	}

	const canClose = done;
	const isActive = !done;
	const title =
		action === "restart"
			? "Restarting Sandbox"
			: action === "stop"
				? "Stopping Sandbox"
				: action === "delete"
					? "Deleting Sandbox"
					: action === "build"
						? "Rebuilding Sandbox"
						: "Starting Sandbox";

	return (
		<Dialog open={open} onOpenChange={canClose ? onOpenChange : undefined}>
			<DialogContent className="sm:max-w-md" onPointerDownOutside={(event) => !canClose && event.preventDefault()}>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{!done && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
						{done && success && <CheckCircle2 className="w-4 h-4 text-green-600" />}
						{done && !success && <XCircle className="w-4 h-4 text-red-600" />}
						{title}
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-3 mt-2">
					{steps
						.filter((step) => step.id !== "logs")
						.map((step) => (
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
											className={cn(
												"text-xs mt-1 whitespace-pre-wrap break-all max-h-96 overflow-y-auto rounded p-2",
												step.status === "error" ? "bg-red-50 text-red-700" : "bg-gray-50 text-gray-700"
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

				<div className="flex justify-end mt-4">
					{isActive && (
						<Button variant="destructive" size="sm" onClick={handleStop} disabled={stopping}>
							<Square className="h-3 w-3" />
							{stopping ? "Stopping..." : "Stop"}
						</Button>
					)}
					{done && (
						<Button variant={success ? "default" : "secondary"} onClick={() => onOpenChange(false)}>
							{success ? "Done" : "Close"}
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
