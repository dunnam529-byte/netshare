'use strict';

const fs = require('fs');
const path = require('path');

class JsonStatement {
    constructor(db, sql) {
        this.db = db;
        this.sql = sql.trim();
    }

    run(...params) {
        // Flatten params in case we are passed an array as the first argument
        if (params.length === 1 && Array.isArray(params[0])) {
            params = params[0];
        }

        const sql = this.sql;

        // 1. INSERT OR IGNORE / INSERT OR REPLACE / INSERT INTO
        const insertRegex = /^\s*INSERT\s+(?:OR\s+(IGNORE|REPLACE)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i;
        let m = sql.match(insertRegex);
        if (m) {
            const mode = m[1] ? m[1].toUpperCase() : null;
            const table = m[2];
            const columns = m[3].split(',').map(c => c.trim());
            const valuesPart = m[4].split(',').map(v => v.trim());

            this.db.initTable(table);

            const row = {};
            let pIdx = 0;
            columns.forEach((col, idx) => {
                const valExpr = valuesPart[idx];
                if (valExpr === '?') {
                    row[col] = params[pIdx++];
                } else if (valExpr.startsWith("'") && valExpr.endsWith("'")) {
                    row[col] = valExpr.slice(1, -1);
                } else if (/^\d+$/.test(valExpr)) {
                    row[col] = parseInt(valExpr, 10);
                } else {
                    row[col] = valExpr;
                }
            });

            // If there is a primary key or unique field, check uniqueness/replacing
            let existingIdx = -1;
            if (table === 'users') {
                existingIdx = this.db.tables[table].findIndex(r => r.uid === row.uid || r.nickname === row.nickname);
            } else if (table === 'pending_users') {
                existingIdx = this.db.tables[table].findIndex(r => r.uid === row.uid || r.nickname === row.nickname);
            } else if (table === 'group_members') {
                existingIdx = this.db.tables[table].findIndex(r => r.group_id === row.group_id && r.uid === row.uid);
            } else if (table === 'read_receipts') {
                existingIdx = this.db.tables[table].findIndex(r => r.channel_key === row.channel_key && r.uid === row.uid);
            } else if (table === 'server_config') {
                existingIdx = this.db.tables[table].findIndex(r => r.key === row.key);
            } else if (row.id) {
                existingIdx = this.db.tables[table].findIndex(r => r.id === row.id);
            }

            if (existingIdx !== -1) {
                if (mode === 'IGNORE') {
                    return { changes: 0, lastInsertRowid: null };
                } else {
                    // Replace
                    this.db.tables[table][existingIdx] = { ...this.db.tables[table][existingIdx], ...row };
                    this.db.save();
                    return { changes: 1, lastInsertRowid: null };
                }
            }

            this.db.tables[table].push(row);
            this.db.save();
            return { changes: 1, lastInsertRowid: null };
        }

        // 2. UPDATE table SET col1 = ?, col2 = ? WHERE condition
        const updateRegex = /^\s*UPDATE\s+(\w+)\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?$/i;
        m = sql.match(updateRegex);
        if (m) {
            const table = m[1];
            const setPart = m[2];
            const wherePart = m[3] || '';

            this.db.initTable(table);

            const setPairs = setPart.split(',').map(s => s.trim());
            const setUpdates = [];
            let setPlaceholderCount = 0;

            setPairs.forEach(pair => {
                const eqIdx = pair.indexOf('=');
                if (eqIdx !== -1) {
                    const col = pair.substring(0, eqIdx).trim();
                    const valExpr = pair.substring(eqIdx + 1).trim();
                    setUpdates.push({ col, valExpr });
                    if (valExpr === '?') setPlaceholderCount++;
                }
            });

            const setParams = params.slice(0, setPlaceholderCount);
            const whereParams = params.slice(setPlaceholderCount);

            let updatedCount = 0;
            const rows = this.db.tables[table];
            rows.forEach(row => {
                if (this.db.evaluateWhere(wherePart, row, whereParams)) {
                    let setPIdx = 0;
                    setUpdates.forEach(({ col, valExpr }) => {
                        if (valExpr === '?') {
                            row[col] = setParams[setPIdx++];
                        } else if (valExpr.startsWith("'") && valExpr.endsWith("'")) {
                            row[col] = valExpr.slice(1, -1);
                        } else if (/^\d+$/.test(valExpr)) {
                            row[col] = parseInt(valExpr, 10);
                        } else {
                            row[col] = valExpr;
                        }
                    });
                    updatedCount++;
                }
            });

            if (updatedCount > 0) {
                this.db.save();
            }
            return { changes: updatedCount, lastInsertRowid: null };
        }

        // 3. DELETE FROM table WHERE condition
        const deleteRegex = /^\s*DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*))?$/i;
        m = sql.match(deleteRegex);
        if (m) {
            const table = m[1];
            const wherePart = m[2] || '';

            this.db.initTable(table);

            const initialCount = this.db.tables[table].length;
            this.db.tables[table] = this.db.tables[table].filter(row => {
                return !this.db.evaluateWhere(wherePart, row, params);
            });

            const deletedCount = initialCount - this.db.tables[table].length;
            if (deletedCount > 0) {
                this.db.save();
            }
            return { changes: deletedCount, lastInsertRowid: null };
        }

        return { changes: 0, lastInsertRowid: null };
    }

    get(...params) {
        const rows = this.all(...params);
        return rows[0];
    }

    all(...params) {
        // Flatten params in case we are passed an array as the first argument
        if (params.length === 1 && Array.isArray(params[0])) {
            params = params[0];
        }

        const sql = this.sql;

        // Custom PRAGMA support
        if (/^\s*PRAGMA\s+table_info/i.test(sql)) {
            const tblMatch = sql.match(/\(([^)]+)\)/);
            if (tblMatch) {
                const tableName = tblMatch[1].trim();
                if (tableName === 'users') {
                    return [
                        { name: 'uid' }, { name: 'nickname' },
                        { name: 'password_hash' }, { name: 'profile_photo' },
                        { name: 'is_admin' }, { name: 'is_approved' },
                        { name: 'created_at' }
                    ];
                } else if (tableName === 'pending_users') {
                    return [
                        { name: 'uid' }, { name: 'nickname' },
                        { name: 'password_hash' }, { name: 'ip' },
                        { name: 'requested_at' }
                    ];
                } else if (tableName === 'group_members') {
                    return [
                        { name: 'group_id' }, { name: 'uid' }, { name: 'role' }
                    ];
                }
            }
            return [];
        }

        // Check for our custom GROUP JOIN query
        if (sql.includes('GROUP_CONCAT') && sql.includes('groups_table')) {
            const myUid = params[0];
            const myGroupMembers = (this.db.tables['group_members'] || []).filter(m => m.uid === myUid);
            const myGroupIds = myGroupMembers.map(m => m.group_id);

            const matchedGroups = (this.db.tables['groups_table'] || []).filter(g => myGroupIds.includes(g.id));
            const result = matchedGroups.map(g => {
                const uids = (this.db.tables['group_members'] || [])
                    .filter(m => m.group_id === g.id)
                    .map(m => m.uid);
                return {
                    id: g.id,
                    name: g.name,
                    created_by: g.created_by,
                    created_at: g.created_at,
                    member_uids: uids.join(',')
                };
            });
            return result;
        }

        // Standard SELECT parsing
        const parsed = this.db.parseSelect(sql);
        if (!parsed.fromTableAndAlias) {
            return [];
        }

        const tableAndAlias = parsed.fromTableAndAlias.trim().split(/\s+/);
        const table = tableAndAlias[0];

        this.db.initTable(table);

        let rows = this.db.tables[table].filter(row => {
            return this.db.evaluateWhere(parsed.whereClause, row, params);
        });

        // Compute comment_count or other virtual fields dynamically
        if (parsed.selectFields.includes('comment_count')) {
            let fileType = 'chat';
            if (parsed.selectFields.includes("'pool'")) {
                fileType = 'pool';
            }
            rows = rows.map(row => {
                const cnt = (this.db.tables['file_comments'] || [])
                    .filter(c => c.file_id === row.id && c.file_type === fileType)
                    .length;
                return { ...row, comment_count: cnt };
            });
        }

        // Count support
        if (/^\s*count\s*\(\*\)/i.test(parsed.selectFields.trim())) {
            const countAlias = parsed.selectFields.match(/as\s+(\w+)/i);
            const key = countAlias ? countAlias[1] : 'count';
            return [{ [key]: rows.length }];
        }

        // Sorting
        if (parsed.orderByClause) {
            const parts = parsed.orderByClause.trim().split(/\s+/);
            let col = parts[0];
            if (col.includes('.')) col = col.split('.')[1];
            const dir = (parts[1] || 'ASC').toUpperCase();

            rows.sort((a, b) => {
                let va = a[col];
                let vb = b[col];
                if (typeof va === 'string' && typeof vb === 'string') {
                    return dir === 'ASC' ? va.localeCompare(vb) : vb.localeCompare(va);
                }
                if (va === undefined || va === null) return dir === 'ASC' ? -1 : 1;
                if (vb === undefined || vb === null) return dir === 'ASC' ? 1 : -1;
                return dir === 'ASC' ? va - vb : vb - va;
            });
        }

        // Limit
        if (parsed.limitVal !== null) {
            rows = rows.slice(0, parsed.limitVal);
        }

        return JSON.parse(JSON.stringify(rows));
    }
}

class JsonDatabase {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.tables = {};
        this.load();
    }

    load() {
        if (this.dbPath === ':memory:') {
            this.tables = {};
            return;
        }

        const jsonPath = this.dbPath.endsWith('.db') ? this.dbPath.replace(/\.db$/, '.json') : this.dbPath + '.json';
        if (fs.existsSync(jsonPath)) {
            try {
                this.tables = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            } catch (err) {
                this.tables = {};
            }
        } else {
            this.tables = {};
        }
    }

    save() {
        if (this.dbPath === ':memory:') {
            return;
        }

        const jsonPath = this.dbPath.endsWith('.db') ? this.dbPath.replace(/\.db$/, '.json') : this.dbPath + '.json';
        const tmpPath = jsonPath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(this.tables, null, 2), 'utf8');
            fs.renameSync(tmpPath, jsonPath);
        } catch (err) {
            // Ignore saving issues during fallback
        }
    }

    initTable(name) {
        if (!this.tables[name]) {
            this.tables[name] = [];
        }
    }

    exec(sql) {
        sql = sql.trim();
        // Support bulk/multi-statement SQL exec
        if (sql.includes(';')) {
            const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
            statements.forEach(s => this.exec(s));
            return;
        }

        const createRegex = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i;
        let m = sql.match(createRegex);
        if (m) {
            this.initTable(m[1]);
            this.save();
            return;
        }

        const alterRegex = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i;
        m = sql.match(alterRegex);
        if (m) {
            const table = m[1];
            const col = m[2];
            this.initTable(table);
            this.tables[table].forEach(row => {
                if (row[col] === undefined) {
                    row[col] = null;
                }
            });
            this.save();
            return;
        }
    }

    prepare(sql) {
        return new JsonStatement(this, sql);
    }

    parseSelect(sql) {
        let selectFields = '';
        let fromTableAndAlias = '';
        let whereClause = '';
        let orderByClause = '';
        let limitVal = null;

        const selectMatch = sql.match(/^\s*SELECT\s+/i);
        const selectStart = selectMatch ? selectMatch[0].length : 6;

        let parenDepth = 0;
        let fromIndex = -1;
        let fromMatchLen = 0;
        for (let i = 0; i < sql.length; i++) {
            if (sql[i] === '(') parenDepth++;
            else if (sql[i] === ')') parenDepth--;
            else if (parenDepth === 0) {
                const match = sql.substring(i).match(/^(\s+FROM\s+)/i);
                if (match) {
                    fromIndex = i;
                    fromMatchLen = match[0].length;
                    break;
                }
            }
        }

        if (fromIndex !== -1) {
            selectFields = sql.substring(selectStart, fromIndex).trim();
            const rest = sql.substring(fromIndex + fromMatchLen).trim();

            function findKeywordDepth0(str, keywordRegex) {
                let depth = 0;
                for (let j = 0; j < str.length; j++) {
                    if (str[j] === '(') depth++;
                    else if (str[j] === ')') depth--;
                    else if (depth === 0) {
                        const m = str.substring(j).match(keywordRegex);
                        if (m) {
                            return { index: j, matchLen: m[0].length };
                        }
                    }
                }
                return null;
            }

            let whereIndex = -1;
            let whereMatchLen = 0;
            let orderByIndex = -1;
            let orderByMatchLen = 0;
            let limitIndex = -1;
            let limitMatchLen = 0;

            const wMatch = findKeywordDepth0(rest, /^(\s+WHERE\s+)/i);
            if (wMatch) {
                whereIndex = wMatch.index;
                whereMatchLen = wMatch.matchLen;
            }
            const oMatch = findKeywordDepth0(rest, /^(\s+ORDER\s+BY\s+)/i);
            if (oMatch) {
                orderByIndex = oMatch.index;
                orderByMatchLen = oMatch.matchLen;
            }
            const lMatch = findKeywordDepth0(rest, /^(\s+LIMIT\s+)/i);
            if (lMatch) {
                limitIndex = lMatch.index;
                limitMatchLen = lMatch.matchLen;
            }

            let tableEnd = rest.length;
            if (whereIndex !== -1) tableEnd = Math.min(tableEnd, whereIndex);
            if (orderByIndex !== -1) tableEnd = Math.min(tableEnd, orderByIndex);
            if (limitIndex !== -1) tableEnd = Math.min(tableEnd, limitIndex);

            fromTableAndAlias = rest.substring(0, tableEnd).trim();

            if (whereIndex !== -1) {
                let whereEnd = rest.length;
                if (orderByIndex !== -1 && orderByIndex > whereIndex) whereEnd = Math.min(whereEnd, orderByIndex);
                if (limitIndex !== -1 && limitIndex > whereIndex) whereEnd = Math.min(whereEnd, limitIndex);
                whereClause = rest.substring(whereIndex + whereMatchLen, whereEnd).trim();
            }
            if (orderByIndex !== -1) {
                let orderByEnd = rest.length;
                if (limitIndex !== -1 && limitIndex > orderByIndex) orderByEnd = Math.min(orderByEnd, limitIndex);
                orderByClause = rest.substring(orderByIndex + orderByMatchLen, orderByEnd).trim();
            }
            if (limitIndex !== -1) {
                limitVal = parseInt(rest.substring(limitIndex + limitMatchLen).trim(), 10);
            }
        }
        return { selectFields, fromTableAndAlias, whereClause, orderByClause, limitVal };
    }

    evaluateWhere(whereClause, row, params) {
        if (!whereClause || !whereClause.trim()) return true;

        let clean = whereClause.replace(/\b(?:cf|pf|fc|gm|g|gm2|m)\.([a-zA-Z0-9_]+)\b/g, '$1');

        const tokens = [];
        let i = 0;
        while (i < clean.length) {
            const char = clean[i];
            if (/\s/.test(char)) {
                i++;
                continue;
            }
            if (char === '(' || char === ')') {
                tokens.push({ type: 'paren', value: char });
                i++;
                continue;
            }
            if (char === ',') {
                tokens.push({ type: 'punct', value: char });
                i++;
                continue;
            }
            if (char === '?') {
                tokens.push({ type: 'param', value: '?' });
                i++;
                continue;
            }
            if (char === "'" || char === '"') {
                const quote = char;
                let val = '';
                i++;
                while (i < clean.length && clean[i] !== quote) {
                    if (clean[i] === '\\\\') {
                        val += clean[i + 1];
                        i += 2;
                    } else {
                        val += clean[i];
                        i++;
                    }
                }
                i++;
                tokens.push({ type: 'string', value: val });
                continue;
            }
            const twoCharOp = clean.substring(i, i + 2);
            if (twoCharOp === '<>' || twoCharOp === '>=' || twoCharOp === '<=') {
                tokens.push({ type: 'op', value: twoCharOp });
                i += 2;
                continue;
            }
            if (char === '=' || char === '>' || char === '<') {
                tokens.push({ type: 'op', value: char });
                i++;
                continue;
            }
            let word = '';
            while (i < clean.length && /[a-zA-Z0-9_.]/.test(clean[i])) {
                word += clean[i];
                i++;
            }
            if (word) {
                tokens.push({ type: 'word', value: word });
                continue;
            }
            tokens.push({ type: 'other', value: char });
            i++;
        }

        let js = '';
        let pIdx = 0;

        for (let idx = 0; idx < tokens.length; idx++) {
            const t = tokens[idx];
            if (t.type === 'paren' || t.type === 'punct') {
                js += t.value;
            } else if (t.type === 'param') {
                js += `params[${pIdx++}]`;
            } else if (t.type === 'string') {
                js += JSON.stringify(t.value);
            } else if (t.type === 'op') {
                if (t.value === '=') js += ' === ';
                else if (t.value === '<>') js += ' !== ';
                else js += ' ' + t.value + ' ';
            } else if (t.type === 'word') {
                const upper = t.value.toUpperCase();
                if (upper === 'AND') js += ' && ';
                else if (upper === 'OR') js += ' || ';
                else if (upper === 'NOT') js += ' !';
                else if (upper === 'NULL') js += ' null ';
                else if (upper === 'TRUE') js += ' true ';
                else if (upper === 'FALSE') js += ' false ';
                else if (upper === 'LIKE') {
                    const lastRowMatch = js.match(/(row\.[a-zA-Z0-9_]+)\s*$/);
                    if (lastRowMatch) {
                        const lhs = lastRowMatch[1];
                        js = js.substring(0, js.length - lastRowMatch[0].length);
                        idx++;
                        let rhs = '';
                        if (tokens[idx].type === 'param') {
                            rhs = `params[${pIdx++}]`;
                        } else if (tokens[idx].type === 'string') {
                            rhs = JSON.stringify(tokens[idx].value);
                        }
                        js += `String(${lhs} || "").toLowerCase().includes(String(${rhs} || "").toLowerCase().replace(/%/g, ""))`;
                    }
                } else if (upper === 'IN') {
                    const lastRowMatch = js.match(/(row\.[a-zA-Z0-9_]+)\s*$/);
                    if (lastRowMatch) {
                        const lhs = lastRowMatch[1];
                        js = js.substring(0, js.length - lastRowMatch[0].length);
                        idx++;
                        if (tokens[idx] && tokens[idx].value === '(') {
                            idx++;
                            const listElements = [];
                            while (idx < tokens.length && tokens[idx].value !== ')') {
                                const cur = tokens[idx];
                                if (cur.type === 'param') {
                                    listElements.push(`params[${pIdx++}]`);
                                } else if (cur.type === 'string') {
                                    listElements.push(JSON.stringify(cur.value));
                                } else if (cur.type === 'word' && !['AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE'].includes(cur.value.toUpperCase())) {
                                    listElements.push(`row.${cur.value}`);
                                }
                                idx++;
                            }
                            js += `[${listElements.join(',')}].includes(${lhs})`;
                        }
                    }
                } else if (/^[0-9]+$/.test(t.value)) {
                    js += t.value;
                } else {
                    let col = t.value;
                    if (col.includes('.')) col = col.split('.')[1];
                    js += `row.${col}`;
                }
            }
        }

        try {
            const fn = new Function('row', 'params', `return (${js});`);
            return fn(row, params);
        } catch (err) {
            return false;
        }
    }
}

module.exports = { JsonDatabase, JsonStatement };
