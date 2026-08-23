# Sprint RBAC — Keşif Raporu (FAZ 0)

Tarih: 2026-06-09  
Yazar: Sprint A öncesi read-only analiz

---

## 1. Rol Sistemi Detaylı Mapping

### Tüm roller (`users.role` text kolonu, no enum)

| Rol | Küme | Açıklama |
|---|---|---|
| `super_admin` | ADMIN + STAFF | Tam yetki |
| `admin` | ADMIN + STAFF | Tam yetki |
| `manager` | ADMIN + STAFF | Yönetici |
| `staff` | STAFF | Personel |
| `consultant` | STAFF | Danışman |
| `editor` | STAFF | İçerik editörü |
| `accountant` | STAFF | Muhasebe |
| `agent` | AGENT | Üst acente |
| `sub_agent` | AGENT | Alt acente |
| `agent_staff` | AGENT | Acente personeli |
| `student` | STUDENT | Öğrenci |

```
lib/roles/src/index.ts

ADMIN_ROLES  = ["super_admin", "admin", "manager"]
STAFF_ROLES  = ["super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant"]
AGENT_ROLES  = ["agent", "sub_agent", "agent_staff"]
STUDENT_ROLES= ["student"]

isAgentRole(role)  → AGENT_ROLES.includes(role)
isStaffRole(role)  → STAFF_ROLES.includes(role)
isAdminRole(role)  → ADMIN_ROLES.includes(role)
```

### Agent — Sub-Agent hiyerarşisi

```
agents tablosu:
  id              serial PK
  userId          integer → users.id (kullanıcı kaydı)
  parentAgentId   integer → agents.id (NULL = üst acente; NOT NULL = sub-agent)

users tablosu:
  managingAgentId integer → agents.id  (yalnızca agent_staff rolü için)
  role            text                 ("agent" | "sub_agent" | "agent_staff")
```

**Hiyerarşi kuralı:**
- `users.role = "agent"` + `agents.parentAgentId IS NULL` → Üst acente
- `users.role = "sub_agent"` + `agents.parentAgentId IS NOT NULL` → Alt acente
- `users.role = "agent_staff"` + `users.managingAgentId = agents.id` → Acente personeli

Ayrı bir `agent_relationships` tablosu **yoktur**.

### `getAgentVisibleIds(userId, role)` — Mevcut davranış

```
artifacts/api-server/src/lib/agentVisibility.ts

agent_staff → managingAgent.id + (sub-agents of managing agent, if managing is top-level)
agent       → agentRec.id + tüm alt-acentelerin id'leri  ← KURAL 2 bu satırı kaldırır
sub_agent   → agentRec.id (sadece kendi)
```

---

## 2. Lead / Application Şema İncelemesi

### leads tablosu (lib/db/src/schema/leads.ts)

| Kolon | Tür | Anlamı |
|---|---|---|
| `agent_id` | integer FK → agents.id | Acente sahibi (NULL = doğrudan lead) |
| `assigned_to_id` | integer FK → users.id | Atanan personel |
| `source` | text | 'web_form', 'website', 'embed:...', 'website-form:...' |
| `origin_type` | text | 'direct', 'agent', 'sub_agent' |
| `origin_entity_type` | text | Kaynak entity türü |
| `origin_entity_id` | integer | Kaynak entity id'si |

### applications tablosu (lib/db/src/schema/applications.ts)

| Kolon | Tür | Anlamı |
|---|---|---|
| `agent_id` | integer FK → agents.id | Acente sahibi (NULL = doğrudan başvuru) |
| `assigned_to_id` | integer FK → users.id | Atanan personel |
| `origin_type` | text | 'direct', 'agent', 'sub_agent' |

### "Acente kaynaklı" tanımı

```sql
-- Lead acente kaynaklı:
leads.agent_id IS NOT NULL

-- Application acente kaynaklı:
applications.agent_id IS NOT NULL
```

`source` kolonu acente ayrımı için kullanılmaz — sadece kanal bilgisi taşır.

---

## 3. Mevcut Görünürlük Kuralları (RBAC)

### GET /api/applications — mevcut filtreleme

```typescript
// artifacts/api-server/src/routes/applications.ts:84-145

if (isStaff) {
  if (!(ADMIN_ROLES).includes(user.role)) {
    // Atama bazlı OR filtresi:
    //   assignedToId = user.id
    //   OR (records.view_unassigned perm varsa) assignedToId IS NULL
    //   OR (records.view_others perm varsa) assignedToId != user.id
    //   OR (agency staff ise) agentId IN agencyAgentIds
    // agentId IS NULL filtresi YOK → acente kaynaklı başvurular görünüyor!
  }
} else if (isAgentRole) {
  // visibleIds = getAgentVisibleIds → [own + subAgents]
  // agentId IN (own, subAgent1, subAgent2, ...)
  // sub-agent kayıtları da görünüyor!
}
```

**Tespit: Staff rolü agent_id IS NULL filtresi uygulamıyor.**  
**Tespit: Agent rolü sub-agent kayıtlarını da görüyor.**

### GET /api/leads — mevcut filtreleme

```typescript
// artifacts/api-server/src/routes/leads.ts:226-233

if (isAgentRole(user.role)) {
  conditions.push(inArray(leadsTable.agentId, visibleIds));
}
// Staff için HİÇBİR agentId filtresi yok → tüm leads görünüyor!
```

**Tespit: Staff için leads listesinde agent_id filtresi tamamen yok.**

### GET /api/applications/:id — mevcut scope check

```typescript
// line 710-723
if (!isStaff) {
  if (isAgentRole) {
    // visibleIds.includes(row.agentId) kontrolü
  }
}
// isStaff ise → HİÇBİR ek kontrol yok, her kaydı görür
```

### GET /api/leads/:id — mevcut scope check

```typescript
// line 473-484
if (isAgentRole) {
  // visibleIds kontrolü
} else if (!isAdmin) {
  // sadece assignedToId kontrolü — agentId kontrolü yok
}
```

---

## 4. Bildirim Altyapısı

### notifications tablosu (lib/db/src/schema/notifications.ts)

Olaylar ve mevcut alıcılar:

| Event | Alıcı Türü | Alıcı Roller / Kişiler |
|---|---|---|
| `lead.created` | role | super_admin, admin, manager, **staff**, consultant |
| `lead.assigned` | assigned | assignedToId |
| `lead.stage_changed` | assigned | assignedToId |
| `lead.follow_up_due` | assigned | assignedToId |
| `application.created` | role | super_admin, admin, manager |
| `application.stage_changed` | owner | Application'ın agent sahibi |
| `application.offer_received` | owner | Application'ın agent sahibi |
| `application.offer_letter_expiring` | owner | Application'ın agent sahibi |
| `application.visa_update` | owner | Application'ın agent sahibi |

### Tespit edilen bildirim açığı

`lead.created` eventi acente kaynaklı olsa bile `staff` ve `consultant` rollerine broadcast yapıyor.  
Sprint A sonrasında staff acente kaynaklı lead'leri göremeyecek; ancak `lead.created` bildirimi hâlâ onlara ulaşacak. Bu tutarsızlık Sprint B'de giderilecek.

### notificationDispatcher.ts

```typescript
// artifacts/api-server/src/lib/notificationDispatcher.ts

dispatchNotification(ctx) → DEFAULT_NOTIFICATION_RULES'dan rule bulur
  → recipientType = "role" ise: inArray(users.role, recipientRoles) ile user id'leri çeker
  → recipientType = "owner" ise: applicationın agent sahibi
  → recipientUserIds verilmişse: direkt kullanır
```

---

## 5. UI Görünürlük

### Frontend (artifacts/edcons)

- `artifacts/edcons/src/pages/staff/Applications.tsx` — Backend scope'a güveniyor; ek agentId filtresi uygulamıyor
- `isAdmin` = role in {super_admin, admin, manager}
- UI permission'ları `hasPermission()` (records.*) hook'u üzerinden
- Frontend liste queries zaten backend filtrelere güveniyor → backend scope değişince otomatik yansır
- Staff için agent filtre dropdown'ı şu an listelerde gösteriliyor (agent kaynaklı olmayan için anlamsız olacak)

---

## Sprint A'nın Operasyonel Etkisi

| Etkilenen Durum | Mevcut | Sprint A Sonrası |
|---|---|---|
| Staff — acente başvurusu atanmış | Görüyor + güncelleyebiliyor | 404 — göremez |
| Staff — acente lead listesi | Listelenebiliyor | Listede yok |
| Agent — sub-agent başvurusu | Görüyor | 404 — göremez |
| Sub-agent — kendi başvurusu | Görüyor | Değişmez |
| agent_staff — managing agent + sub-agents | Görüyor | Değişmez (out of scope) |

> **Uyarı:** Acente firmalarının yönetimine atanmış staff kullanıcıları (agencyAgentIds ile erişim alan) acente kaynaklı başvuruları artık göremeyecek. Deploy öncesi etkilenen kullanıcılar bilgilendirilmeli.
