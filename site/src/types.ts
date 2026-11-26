// Типы собранного tree.json (контракт: docs/data-format.md)

export type Status =
  | 'strongly-corroborated'
  | 'corroborated'
  | 'single-source'
  | 'family-report'
  | 'hypothesis'
  | 'unresolved';

export type Sex = 'M' | 'F' | 'U';

export interface PersonName {
  surname: string | null; // null — фамилия не известна
  given: string;
  patronymic?: string | null;
  birthSurname?: string | null;
  otherSurnames?: string[];
}

export interface DatedEvent {
  date?: string | null;
  text?: string | null;
  place?: string | null;
  status?: Status;
  sources?: string[];
}

export interface Fact {
  type: string;
  date?: string | null;
  text?: string | null;
  status?: Status;
  sources?: string[];
}

export interface Photo {
  file: string;
  caption?: string | null;
  year?: string | null;
  sources?: string[];
}

export interface Note {
  text: string;
  sources?: string[];
}

export interface Person {
  id: string;
  folder?: string; // у живых отсутствует
  living: boolean;
  sex?: Sex;
  name: PersonName;
  status?: Status;
  birth?: DatedEvent | null;
  death?: DatedEvent | null;
  facts?: Fact[];
  photos?: Photo[];
  notes?: Note[];
}

export type SourceKind = 'archive' | 'family-document' | 'family-memory' | 'reference';

export interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  repository?: string | null;
  reference?: string | null;
  date?: string | null;
  url?: string | null;
  note?: string | null;
}

export interface ParentRelation {
  type: 'parent';
  parent: string;
  child: string;
  status: Status;
  sources: string[];
}

export interface SpouseRelation {
  type: 'spouse';
  a: string;
  b: string;
  status: Status;
  date?: string | null;
  sources: string[];
}

export type Relation = ParentRelation | SpouseRelation;

export interface TreeData {
  generated: string;
  rootId: string;
  title?: string;
  persons: Person[];
  sources: Source[];
  relations: Relation[];
}
