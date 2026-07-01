declare module "@lancedb/lancedb" {
	export interface Connection {
		tableNames(): Promise<string[]>;
		openTable(name: string): Table;
		createTable(name: string, data: any[]): Promise<Table>;
		dropTable(name: string): Promise<void>;
	}

	export interface Table {
		add(data: any[]): Promise<void>;
		delete(filter: string): Promise<void>;
		search(vector: number[]): SearchBuilder;
		query(): QueryBuilder;
	}

	export interface SearchBuilder {
		limit(n: number): SearchBuilder;
		where(filter: string): SearchBuilder;
		toArray(): Promise<any[]>;
	}

	export interface QueryBuilder {
		where(filter: string): QueryBuilder;
		limit(n: number): QueryBuilder;
		toArray(): Promise<any[]>;
	}

	export function connect(uri: string): Promise<Connection>;
}
