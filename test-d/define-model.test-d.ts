import { expectType, expectError, expectAssignable, expectNotAssignable } from 'tsd';
import {
	defineModel,
	applyTableNames,
	registerModels,
	getRegisteredModel,
	checkLinks,
	loadDefinition,
	convertDefinition,
	DatabaseObject,
	type ModelFields,
	type ModelData,
	type ModelInput,
	type SchemaTypes,
	type AnyModelClass,
	type DefinedModel,
	type LinkedFieldType,
} from 'yass-orm';

// ---------------------------------------------------------------------------
// Field types, inferred from the schema
// ---------------------------------------------------------------------------

const Org = defineModel({
	table: 'orgs',
	prefix: 'org',
	schema: (t) => ({
		id: t.stringKey,
		name: t.string.default(''),
		slug: t.string.exact().maxLength(64),
		notes: t.text,
		seats: t.int.min(0),
		score: t.real,
		big: t.bigint,
		active: t.bool,
		founded: t.date,
		opens: t.time,
		createdOn: t.datetime.precision(3),
		touchedAt: t.datetime({ defaultValue: 'CURRENT_TIMESTAMP' }),
		plan: t.enum(['free', 'pro']),
		tier: t.enum(['a', 'b', 'c']).default('a'),
		settings: t.object({ theme: t.string, size: t.int }),
		stamped: t.object({ at: t.datetime, by: t.linked(() => Counter) }),
		dates: t.array(t.datetime),
		loose: t.object(),
		legacy: t.object({ schema: { city: t.string } }),
		tags: t.array(t.string),
		steps: t.array(t.object({ label: t.string })),
		kinds: t.array(t.enum(['x', 'y'])),
		anything: t.any,
		color: t.color,
		ref: t.uuid,
		members: t.hasMany('member'),
		explicitNull: t.int.nullable(),
		described: t.string.description('what it is').example('x'),
	}),
});

type OrgRow = InstanceType<typeof Org>;
declare const org: OrgRow;

// Keys can't be null; a NOT NULL column (a default, or t.bool) can't either.
expectType<string>(org.id);
expectType<string>(org.name);
expectType<boolean>(org.active);
expectType<Date>(org.touchedAt);
expectType<'a' | 'b' | 'c'>(org.tier);
// Every other column is nullable, as it is in SQL.
expectType<string | null>(org.slug);
expectType<string | null>(org.notes);
expectType<number | null>(org.seats);
expectType<number | null>(org.score);
expectType<string | null>(org.big);
expectType<string | null>(org.founded);
expectType<string | null>(org.opens);
expectType<Date | null>(org.createdOn);
expectType<'free' | 'pro' | null>(org.plan);
expectType<{ theme?: string | null; size?: number | null } | null>(
	org.settings,
);
// Inside JSON a datetime is its ISO string, a link its id.
expectType<{
	at?: string | null;
	by?: string | number | null;
} | null>(org.stamped);
expectType<unknown[] | null>(org.dates);
expectType<Record<string, unknown> | null>(org.loose);
expectType<{ city?: string | null } | null>(org.legacy);
expectType<string[] | null>(org.tags);
expectType<Array<{ label?: string | null }> | null>(org.steps);
// An enum's options don't survive t.array() at runtime: plain strings.
expectType<string[] | null>(org.kinds);
expectType<unknown>(org.anything);
expectType<string | null>(org.color);
expectType<string | null>(org.ref);
expectType<number | null>(org.explicitNull);
expectType<string | null>(org.described);
// Every def gets isDeleted.
expectType<boolean>(org.isDeleted);
// t.hasMany is a hint, not a column.
expectError(org.members);
// Not in the schema.
expectError(org.nope);

// The chain methods exist only where they do at runtime.
defineModel({ table: 'x', schema: (t) => ({ a: t.string.minLength(1).email() }) });
expectError(defineModel({ table: 'x', schema: (t) => ({ a: t.int.email() }) }));
expectError(defineModel({ table: 'x', schema: (t) => ({ a: t.string.min(1) }) }));
expectError(
	defineModel({ table: 'x', schema: (t) => ({ a: t.string.precision(3) }) }),
);
// A default has the field's type.
expectError(defineModel({ table: 'x', schema: (t) => ({ a: t.int.default('1') }) }));
expectError(
	defineModel({ table: 'x', schema: (t) => ({ a: t.enum(['p', 'q']).default('r') }) }),
);
// table and schema are required.
expectError(defineModel({ schema: (t: SchemaTypes) => ({ a: t.string }) }));
expectError(defineModel({ table: 'x' }));

// No id in the schema: the default auto-increment key.
const Counter = defineModel({
	table: 'counters',
	schema: (t) => ({ value: t.int }),
});
declare const counter: InstanceType<typeof Counter>;
expectType<number>(counter.id);

// ---------------------------------------------------------------------------
// Instance methods and statics are typed on the model and its subclasses
// ---------------------------------------------------------------------------

expectType<Promise<OrgRow | null>>(Org.get('org_1'));
expectType<Promise<OrgRow[]>>(Org.search({ name: 'a' }));
expectType<Promise<OrgRow | null>>(Org.searchOne({ name: 'a' }));
expectType<Promise<OrgRow>>(org.patch({ name: 'b' }));
expectType<Promise<Record<string, any>>>(org.jsonify());
expectType<string>(Org.table());
expectType<string>(Org.generateObjectId());

// create() takes the schema's fields, all optional.
expectType<Promise<OrgRow>>(Org.create({ name: 'a', seats: 3, plan: 'pro' }));
expectType<Promise<OrgRow>>(Org.create({}));
expectError(Org.create({ name: 3 }));
expectError(Org.create({ plan: 'enterprise' }));
expectError(Org.create({ nope: 1 }));
expectError(Org.create({ name: null })); // NOT NULL (it has a default)
Org.create({ slug: null }); // nullable

class OrgModel extends Org {
	get label() {
		return `${this.name} (${this.seats ?? 0})`;
	}

	async rename(name: string) {
		return this.patch({ name });
	}

	static bySlug(slug: string) {
		return this.searchOne({ slug });
	}
}

declare const orgModel: OrgModel;
expectType<string>(orgModel.label);
expectType<string>(orgModel.name);
expectType<Promise<OrgModel>>(orgModel.rename('c'));
expectType<Promise<OrgModel | null>>(OrgModel.get('org_1'));
expectType<Promise<OrgModel | null>>(OrgModel.bySlug('s'));
expectType<Promise<OrgModel>>(OrgModel.create({ name: 'x' }));
expectType<Promise<OrgModel[]>>(OrgModel.search({}));
expectType<Promise<OrgModel | null>>(OrgModel.inflate({ id: 'org_1' }));

// ---------------------------------------------------------------------------
// Links resolve to the linked model's instance type
// ---------------------------------------------------------------------------

const Member = defineModel({
	table: 'members',
	prefix: 'mem',
	schema: (t) => ({
		id: t.stringKey,
		email: t.string.exact(),
		// A lazy reference to a subclass: its methods come through.
		org: t.linked(() => OrgModel),
		// ...and to the model defineModel returned.
		plainOrg: t.linked(() => Org),
		// A dynamic import (a module with a default export).
		imported: t.linked(() => Promise.resolve({ default: OrgModel })),
		// A registered name (see the ModelRegistry below).
		team: t.linked('team'),
		// A path: resolves at runtime; typed as any model.
		byPath: t.linked('../models/thing'),
		up: t.parent(() => OrgModel),
		required: t.linked(() => OrgModel).default('org_1'),
		describedLink: t.linked(() => OrgModel).description('the org'),
	}),
});
declare const member: InstanceType<typeof Member>;
expectType<OrgModel | null>(member.org);
expectType<OrgRow | null>(member.plainOrg);
expectType<OrgModel | null>(member.imported);
expectType<OrgModel | null>(member.up);
expectType<OrgModel>(member.required);
expectType<OrgModel | null>(member.describedLink);
expectType<DatabaseObject | null>(member.byPath);
if (member.org) {
	expectType<string>(member.org.label);
}

// create() takes a link as the linked instance or its id.
Member.create({ org: orgModel });
Member.create({ org: 'org_1' });
Member.create({ org: null });
expectError(Member.create({ org: { id: 'org_1' } as unknown as boolean }));

// ---------------------------------------------------------------------------
// Registered names: typed through ModelRegistry, and they may form cycles
// ---------------------------------------------------------------------------

const Team = defineModel({
	table: 'teams',
	schema: (t) => ({
		id: t.stringKey,
		name: t.string,
		// A cycle: team -> member -> team, and a self-link, by name.
		lead: t.linked('member'),
		parentTeam: t.linked('team'),
	}),
});
class TeamModel extends Team {
	shout() {
		return `${this.name}!`;
	}
}

declare module 'yass-orm' {
	interface ModelRegistry {
		team: typeof TeamModel;
		member: typeof Member;
	}
}

expectType<TeamModel | null>(member.team);
declare const team: TeamModel;
expectType<InstanceType<typeof Member> | null>(team.lead);
expectType<TeamModel | null>(team.parentTeam);
if (team.parentTeam) {
	expectType<string>(team.parentTeam.shout());
}
expectType<typeof TeamModel | undefined>(getRegisteredModel('team'));

// The registry takes defined models (and still checks the registered type).
registerModels({ team: TeamModel, member: Member });
registerModels({ unlisted: Org });
expectError(registerModels({ team: Org }));
checkLinks({ models: [Org, Member, TeamModel] });

// A defined model is a model class: links and the registry accept it.
expectAssignable<AnyModelClass>(Org);
expectAssignable<AnyModelClass>(OrgModel);
expectAssignable<AnyModelClass>(loadDefinition('./defs/x'));

// ---------------------------------------------------------------------------
// Types a consumer can name
// ---------------------------------------------------------------------------

type OrgSchema = typeof Org extends DefinedModel<infer S> ? S : never;
expectType<string | null>({} as ModelFields<OrgSchema>['slug']);
expectType<string | undefined>({} as ModelData<OrgSchema>['name']);
expectType<string | null | undefined>({} as ModelData<OrgSchema>['slug']);

type MemberSchema = typeof Member extends DefinedModel<infer S> ? S : never;
// Plain data holds a link as its id.
expectType<string | number | null | undefined>(
	{} as ModelData<MemberSchema>['org'],
);
expectAssignable<ModelInput<MemberSchema>['org']>(orgModel);

// ---------------------------------------------------------------------------
// Model.zod, the definition, and table names
// ---------------------------------------------------------------------------

const parsed = Org.zod.parse({});
expectType<string | undefined>(parsed.name);
expectType<'free' | 'pro' | null | undefined>(parsed.plan);
const result = Org.zod.safeParse({});
if (result.success) {
	expectType<ModelData<OrgSchema>>(result.data);
}

expectType<string>(Org.defaultTable);
expectType<typeof Org>(Org.useTable('tessera_orgs'));
expectType<typeof OrgModel>(OrgModel.useTable('tessera_orgs'));
convertDefinition(Org);
convertDefinition(Org.definition);

expectType<Record<string, string>>(
	applyTableNames([Org, Member], { tables: { orgs: 'tessera_orgs' } }),
);
applyTableNames({ Org, Member }, { tablePrefix: 'tessera_' });
expectError(applyTableNames([Org], { tables: { orgs: 42 } }));

// A defined model isn't the loosely typed DatabaseObject: its id is typed.
expectNotAssignable<typeof DatabaseObject>(Counter);

// A bare LinkedFieldType (the pre-defineModel annotation) takes every link:
// a lazy reference, a class, a registered name, a path, with a default.
declare const schemaTypes: SchemaTypes;
expectAssignable<LinkedFieldType>(schemaTypes.linked(() => OrgModel));
expectAssignable<LinkedFieldType>(schemaTypes.linked(OrgModel));
expectAssignable<LinkedFieldType>(schemaTypes.linked('team'));
expectAssignable<LinkedFieldType>(schemaTypes.linked('../models/thing'));
expectAssignable<LinkedFieldType>(
	schemaTypes.linked(() => OrgModel).default('org_1'),
);
expectAssignable<LinkedFieldType<typeof OrgModel>>(schemaTypes.linked(OrgModel));
// ...and it still carries its nullability.
expectType<OrgModel | null>(
	({} as ModelFields<{ o: ReturnType<typeof schemaTypes.linked<typeof OrgModel>> }>).o,
);
