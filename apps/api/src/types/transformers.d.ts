declare module "@xenova/transformers" {
	export interface PipelineOutput {
		data: Float32Array | number[];
		[key: string]: any;
	}

	export type FeatureExtractionPipeline = (
		text: string,
		options?: { pooling?: string; normalize?: boolean }
	) => Promise<PipelineOutput>;

	export function pipeline(task: string, model: string): Promise<FeatureExtractionPipeline>;
}
