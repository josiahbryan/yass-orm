import { expectType } from 'tsd';
import { DatabaseObject, type DbHandle } from 'yass-orm';

declare const tx: DbHandle;

// find() and fromSql() take the transaction to read on
DatabaseObject.find({ name: 'x' }, { tx });
expectType<Promise<Array<DatabaseObject>>>(
	DatabaseObject.fromSql('name = :name', { name: 'x', tx }),
);
