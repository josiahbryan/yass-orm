import { expectType } from 'tsd';
import { loadDefinition, DatabaseObject, type FinderResult } from 'yass-orm';

class MyModel extends loadDefinition('./defs/my-model') {
	hello() {
		return 'world';
	}
}

// Static methods should be available and properly typed.
expectType<Promise<MyModel | null>>(MyModel.get('id_123'));
expectType<Promise<MyModel>>(MyModel.create({ id: 'id_123' }));
expectType<Promise<MyModel>>(MyModel.findOrCreate({ id: 'id_123' }));

// search(): array vs single row based on limitOne flag
expectType<Promise<MyModel[]>>(MyModel.search({ id: 'id_123' }));
expectType<Promise<MyModel | null>>(MyModel.search({ id: 'id_123' }, true));

// withDbh() overloads
expectType<Promise<number>>(
	MyModel.withDbh(async (dbh, table) => {
		expectType<string>(table);
		await dbh.pquery(`SELECT 1 FROM ${table} LIMIT 1`);
		return 123;
	}),
);
expectType<Promise<any>>(MyModel.withDbh('SELECT 1', {}));

// find() returns a packet (not instances)
expectType<Promise<FinderResult<Record<string, any>>>>(
	MyModel.find({ $limit: 10 }),
);

// Ensure DatabaseObject base is usable as a type.
expectType<DatabaseObject>({} as DatabaseObject);
