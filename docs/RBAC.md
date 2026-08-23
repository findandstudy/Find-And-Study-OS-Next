# Access Control Matrix — Lead & Application Visibility

Son güncelleme: 2026-06-09 (Sprint A)

---

## Rol Tanımları

| Küme | Roller |
|---|---|
| ADMIN | super_admin, admin, manager |
| STAFF (non-admin) | staff, consultant, editor, accountant |
| AGENT | agent, sub_agent, agent_staff |
| STUDENT | student |

---

## Lead Erişim Kuralları

| Rol | List (GET /api/leads) | Detail (GET /api/leads/:id) | Update (PATCH) | Delete (DELETE) |
|---|---|---|---|---|
| super_admin / admin / manager | Tüm leadler | Tüm leadler | İzin verilir | İzin verilir |
| staff / consultant / editor / accountant | **agentId IS NULL** olanlar | 404 (agentId NOT NULL ise) | 404 (agentId NOT NULL ise) | 404 (agentId NOT NULL ise) |
| agent | Sadece kendi agentId'si | Sadece kendi agentId'si | Sadece kendi | Erişim yok (route sadece STAFF_ROLES) |
| sub_agent | Sadece kendi agentId'si | Sadece kendi agentId'si | Sadece kendi | Erişim yok |
| agent_staff | Managing agent + sub-agents | Managing agent + sub-agents | Managing agent + sub-agents | Erişim yok |
| student | Kendi studentId'si | Kendi | Erişim yok | Erişim yok |

### Lead Sub-Resource'ları (notes, documents, follow-ups)

Aynı kural uygulanır: eğer lead agentId NOT NULL ise ve kullanıcı non-admin staff ise → 404.

---

## Application Erişim Kuralları

| Rol | List (GET /api/applications) | Detail (GET /:id) | Update (PATCH) | Delete (DELETE) | Notes (GET /:id/notes) |
|---|---|---|---|---|---|
| super_admin / admin / manager | Tüm başvurular | Tüm başvurular | İzin verilir | İzin verilir | İzin verilir |
| staff / consultant / editor / accountant | **agentId IS NULL** + atama kuralları | 404 (agentId NOT NULL ise) | 404 (agentId NOT NULL ise) | 404 (agentId NOT NULL ise) | 404 (agentId NOT NULL ise) |
| agent | Sadece kendi agentId'si (**sub-agent hariç**) | Sadece kendi | Sadece kendi | Erişim yok | Sadece kendi |
| sub_agent | Sadece kendi agentId'si | Sadece kendi | Sadece kendi | Erişim yok | Sadece kendi |
| agent_staff | Managing agent + sub-agents (top-level ise) | Managing agent scope | Managing agent scope | Erişim yok | Managing agent scope |
| student | Kendi studentId'si | Kendi | Erişim yok | Erişim yok | Erişim yok |

---

## Sprint A'dan Önceki Davranıştan Farklar (Breaking Changes)

### KURAL 1: Staff — Acente Kaynaklı Kayıtlar

**Eski davranış:** Non-admin staff, acente kaynaklı (agentId IS NOT NULL) bir başvuruya atanmışsa (`assignedToId = user.id`) veya agency-assigned staff listesindeyse o başvuruyu görebiliyordu.

**Yeni davranış:** Non-admin staff, `agentId IS NOT NULL` olan hiçbir lead veya başvuruyu göremez; atanmış olsa dahi. Tüm erişimler 404 döner (403 değil — bilgi sızıntısını önlemek için).

**Etkilenen roller:** staff, consultant, editor, accountant

**Operasyonel etki:**
- Acente firmalarına `assignedStaffId` ile atanmış staff üyeleri (agencyStaff) bu firmaların başvurularını artık göremez
- Acente kaynaklı başvuruya atanmış (assignedToId) staff üyeleri erişimini kaybeder
- Bu kullanıcılar için dashboard/pipeline sayıları sadece direkt başvuruları yansıtır

### KURAL 2: Agent — Sub-Agent Kayıtları

**Eski davranış:** Üst acente (`role = "agent"`), kendi kayıtlarına ek olarak tüm alt-acentelerinin (sub-agent) kayıtlarını görüyordu (`getAgentVisibleIds` → `[own, ...subAgents]`).

**Yeni davranış:** Üst acente yalnızca kendi `agentId`'siyle eşleşen kayıtları görür. Sub-agent'ların getirdiği kayıtlara erişemez.

**Değişmeyen davranış:**
- `agent_staff` rolündeki kullanıcıların görünürlüğü korunmaktadır (managing agent + sub-agents)
- `sub_agent` rolü sadece kendi kayıtlarını zaten görüyordu; değişmez

---

## "Acente Kaynaklı" Tanımı

```
leads.agent_id IS NOT NULL       → acente kaynaklı lead
applications.agent_id IS NOT NULL → acente kaynaklı başvuru
```

`source`, `origin_type` alanları bu tanım için kullanılmaz; sadece kanal bilgisi taşır.

---

## İlgili Dosyalar

- `artifacts/api-server/src/lib/rbac/agentSourceScope.ts` — scope helper
- `artifacts/api-server/src/lib/agentVisibility.ts` — getAgentVisibleIds
- `artifacts/api-server/src/routes/applications.ts`
- `artifacts/api-server/src/routes/leads.ts`
- `lib/roles/src/index.ts` — rol grupları
