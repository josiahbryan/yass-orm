import { expectType, expectError, expectAssignable } from 'tsd';
import {
	loadDefinition,
	convertDefinition,
	registerModel,
	registerModels,
	getRegisteredModel,
	checkLinks,
	DatabaseObject,
	type ModelClass,
	type LinkedModelOf,
	type LinkCheckReport,
	type SchemaTypes,
	type DefinitionFunction,
} from 'yass-orm';

class User extends loadDefinition('./defs/user') {
	greet() {
		return 'hi';
	}
}
class Org extends loadDefinition('./defs/org') {}

// Consumers type the registry by declaration merging.
declare module 'yass-orm' {
	interface ModelRegistry {
		user: typeof User;
	}
}

// ---------------------------------------------------------------------------
// t.linked: a lazy reference, a registered name, or a path (all accepted)
// ---------------------------------------------------------------------------

// Stands in for `() => import('./user.js')`.
declare function importUser(): Promise<{ default: typeof User }>;

const definition: DefinitionFunction = ({ types: t }) => ({
	table: 'orgs',
	schema: {
		id: t.idKey,
		owner: t.linked(() => User),
		ownerWithOptions: t.linked(() => User, { inverse: null }),
		described: t.linked(() => User).description('the owner'),
		byName: t.linked('user'),
		byPath: t.linked('../models/user'),
		cycleSafe: t.linked(() => importUser()),
		up: t.parent(() => Org),
	},
});
convertDefinition(definition);
loadDefinition(definition);

// The old untyped style still compiles.
loadDefinition(({ types: t }: { types: any }) => ({
	table: 'x',
	schema: { id: t.idKey, owner: t.linked('user') },
}));

declare const t: SchemaTypes;
expectType<typeof User | undefined>(t.linked(() => User).__linkedModel);
expectType<typeof User | undefined>(t.linked('user').__linkedModel);
expectType<ModelClass | undefined>(t.linked('../models/user').__linkedModel);
expectError(t.linked(42));
expectError(t.linked(() => 'not a model'));

// The model a link target names
expectType<typeof User>({} as LinkedModelOf<() => typeof User>);
expectType<typeof User>(
	{} as LinkedModelOf<() => Promise<{ default: typeof User }>>,
);
expectType<typeof User>({} as LinkedModelOf<typeof User>);
expectType<typeof User>({} as LinkedModelOf<'user'>);
expectType<ModelClass>({} as LinkedModelOf<'./some/path'>);

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

expectType<() => void>(registerModel('user', User));
expectType<() => void>(registerModel('unlisted', Org));
expectError(registerModel('user', 'not a model'));
expectError(registerModel('unlisted', 42));

expectType<() => void>(registerModels({ user: User, org: Org }));
expectError(registerModels({ user: 42 }));

expectType<typeof User | undefined>(getRegisteredModel('user'));
expectType<ModelClass | undefined>(getRegisteredModel('unlisted'));
expectAssignable<typeof DatabaseObject | undefined>(
	getRegisteredModel('unlisted'),
);

// ---------------------------------------------------------------------------
// The link check
// ---------------------------------------------------------------------------

expectType<Promise<LinkCheckReport>>(checkLinks());
expectType<Promise<LinkCheckReport>>(
	checkLinks({ models: [User, Org], throwIfBroken: true }),
);
expectType<Promise<LinkCheckReport>>(checkLinks({ models: { User, Org } }));
expectError(checkLinks({ models: 'user' }));

checkLinks().then(({ ok, checked, problems }) => {
	expectType<boolean>(ok);
	expectType<number>(checked);
	const [problem] = problems;
	expectType<string>(problem.model);
	expectType<string>(problem.table);
	expectType<string>(problem.field);
	expectType<string>(problem.link);
	expectType<string>(problem.message);
});
