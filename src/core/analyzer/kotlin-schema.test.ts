/**
 * Kotlin schema models behind import gates (change: add-kotlin-schema-inventory, issue #546).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UNRESOLVED_SCHEMA_NAME, extractKotlinSchemas } from './kotlin-schema.js';
import { extractSchemas, type SchemaScanReceipts } from './schema-extractor.js';

const tables = (source: string) => extractKotlinSchemas(source).tables.map(t => ({
  name: t.name, framework: t.framework,
  fields: t.fields.map(f => `${f.name}:${f.type}${f.nullable ? '?' : ''}${f.relation ? ` ->${f.relation.kind}(${f.relation.target ?? ''})` : ''}`),
}));

describe('Kotlin schema extraction', () => {
  it('reads JPA entities: table name, constructor and body properties, column annotations, relations', () => {
    expect(tables([
      'package a',
      'import jakarta.persistence.*',
      '@Entity',
      '@Table(name = "users")',
      'data class User(',
      '  @Id val id: Long,',
      '  @Column(name = "full_name", nullable = false) val name: String,',
      '  val email: String?,',
      '  plainParameter: Int,',
      ') {',
      '  @Column(name = "nick") var nickname: String? = null',
      '  @Transient var cache: String = ""',
      '  @OneToMany(mappedBy = "user") val orders: List<Order> = emptyList()',
      '  @ManyToOne @JoinColumn(name = "team_id") var team: Team? = null',
      '  companion object {',
      '    val DEFAULT = 1',
      '  }',
      '}',
      '@Entity',
      'class Order(@Id val id: Long, val total: Long)',
      'class NotAnEntity(val x: Int)',
    ].join('\n'))).toEqual([
      { name: 'users', framework: 'jpa', fields: ['id:Long', 'full_name:String', 'email:String??', 'nick:String??', 'orders:List<Order> ->OneToMany(Order)', 'team_id:Team?? ->ManyToOne(Team)'] },
      { name: 'Order', framework: 'jpa', fields: ['id:Long', 'total:Long'] },
    ]);
  });

  it('reads Spring Data relational entities', () => {
    expect(tables('import org.springframework.data.relational.core.mapping.Table\nimport org.springframework.data.relational.core.mapping.Column\nimport org.springframework.data.annotation.Id\n@Table("accounts")\ndata class Account(@Id val id: Long?, @Column("display_name") val name: String, val balance: Long)\n'))
      .toEqual([{ name: 'accounts', framework: 'spring-data-relational', fields: ['id:Long?', 'display_name:String', 'balance:Long'] }]);
  });

  it('reads Room entities: table name, column info, primary key, ignored fields, foreign keys', () => {
    expect(tables('import androidx.room.*\n@Entity(tableName = "notes", foreignKeys = [ForeignKey(entity = Folder::class, parentColumns = ["id"], childColumns = ["folder_id"])])\ndata class Note(\n  @PrimaryKey val id: Long,\n  @ColumnInfo(name = "folder_id") val folderId: Long,\n  val body: String?,\n) {\n  @Ignore var selected: Boolean = false\n}\n@Entity\ndata class Folder(@PrimaryKey val id: Long)\n'))
      .toEqual([
        { name: 'notes', framework: 'room', fields: ['id:Long', 'folder_id:Long', 'body:String??', 'fk:Folder:foreign-key ->ForeignKey(Folder)'] },
        { name: 'Folder', framework: 'room', fields: ['id:Long'] },
      ]);
  });

  it('reads Exposed table objects and column functions', () => {
    expect(tables([
      'import org.jetbrains.exposed.sql.Table',
      'import org.jetbrains.exposed.dao.id.IntIdTable',
      'object Orders : Table("orders") {',
      '  val id = integer("id").autoIncrement()',
      '  val userId = varchar("user_id", 64).references(Users.id)',
      '  val note = text("note").nullable()',
      '  val owner = reference("owner_id", Users)',
      '  override val primaryKey = PrimaryKey(id)',
      '  fun helper() = 1',
      '}',
      'object UsersTable : IntIdTable() {',
      '  val name = varchar("name", 50)',
      '}',
      'object Plain {',
      '  val x = integer("x")',
      '}',
    ].join('\n'))).toEqual([
      { name: 'orders', framework: 'exposed', fields: ['id:integer', 'user_id:varchar ->reference(Users)', 'note:text?', 'owner_id:reference ->reference(Users)'] },
      { name: 'Users', framework: 'exposed', fields: ['id:intid', 'name:varchar'] },
    ]);
  });

  it('records a name that is not a string literal as unresolved', () => {
    expect(tables('import jakarta.persistence.*\nconst val T = "t"\n@Entity\n@Table(name = T)\nclass A(@Id val id: Long, @Column(name = COL) val x: String)\n'))
      .toEqual([{ name: UNRESOLVED_SCHEMA_NAME, framework: 'jpa', fields: ['id:Long', `${UNRESOLVED_SCHEMA_NAME}:String`] }]);
  });

  it('extracts nothing without the import gate', () => {
    expect(tables('@Entity\n@Table(name = "users")\nclass User(@Id val id: Long)\n')).toEqual([]);
    expect(tables('class Table(val name: String)\nobject Orders : Table("orders") {\n  val id = integer("id")\n}\n')).toEqual([]);
  });

  it('counts a known persistence library that is not modeled', () => {
    expect(extractKotlinSchemas('import org.jooq.DSLContext\nimport org.ktorm.database.Database\nclass Repo\n'))
      .toEqual({ tables: [], fragments: [], unmodeled: ['jooq', 'ktorm'] });
  });
});

describe('Kotlin schemas in the inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'openlore-kotlin-schema-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, content: string): string => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  it('attaches mapped-superclass and embeddable columns across files, and reports the receipt', async () => {
    const files = [
      write('model/Base.kt', 'package m\nimport jakarta.persistence.*\n@MappedSuperclass\nabstract class Base(@Id val id: Long, @Column(name = "tenant_id") val tenant: String)\n'),
      write('model/Address.kt', 'package m\nimport jakarta.persistence.*\n@Embeddable\ndata class Address(val street: String, val city: String?)\n'),
      write('model/Customer.kt', 'package m\nimport jakarta.persistence.*\n@Entity\n@Table(name = "customers")\nclass Customer(id: Long, tenant: String, val name: String, @Embedded val address: Address, val unknownType: Elsewhere) : Base(id, tenant)\n'),
      write('repo/Legacy.kt', 'package r\nimport org.jooq.DSLContext\nclass Legacy(val ctx: DSLContext)\n'),
    ];
    const receipts: SchemaScanReceipts = { unmodeledFrameworks: {} };
    const schemas = await extractSchemas(files, root, undefined, receipts);
    expect(schemas).toEqual([{
      name: 'customers', file: 'model/Customer.kt', orm: 'jpa', line: 5,
      fields: [
        { name: 'name', type: 'String', nullable: false },
        { name: 'unknownType', type: 'Elsewhere', nullable: false },
        { name: 'id', type: 'Long', nullable: false },
        { name: 'tenant_id', type: 'String', nullable: false },
        { name: 'street', type: 'String', nullable: false },
        { name: 'city', type: 'String?', nullable: true },
      ],
    }]);
    expect(receipts.unmodeledFrameworks).toEqual({ jooq: 1 });
  });
});
