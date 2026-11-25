"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, Download, LoaderCircle, Plus, Sparkles } from "lucide-react";
import { api, type EscalationQueueItem, type ReviewedResolution, type SupportTicket, type TicketWorkflowContext, type TriageReport, type TriageReview, type TicketAnalysis, type TicketHistory } from "@/lib/api";
import { loadVisibleTickets } from "@/lib/support-data";

type Props = { canCreate: boolean; canComment: boolean; canAi: boolean; canResolution: boolean; canAudit: boolean; isLead: boolean; canApprove: boolean; canEscalate: boolean; canResolveEscalation: boolean; reviewerId: string; requesterDisplayName?: string; requesterEmail?: string; teams: { id: string; name: string }[]; canRoute: boolean; canPrioritize: boolean; onError: (error: unknown) => void; onSuccess: (message: string) => void };
type ReviewQueueItem = { ticket: SupportTicket; report: TriageReport };
const AUTO_P1_HANDOVER = "P1 Critical priority requires immediate escalation under the priority policy.";

export function SupportWorkspace({ canCreate, canComment, canAi, canResolution, canAudit, isLead, canApprove, canEscalate, canResolveEscalation, reviewerId, requesterDisplayName, requesterEmail, teams, canRoute, canPrioritize, onError, onSuccess }: Props) {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selected, setSelected] = useState<SupportTicket | null>(null); const [history, setHistory] = useState<TicketHistory[]>([]); const [analyses, setAnalyses] = useState<TicketAnalysis[]>([]);
  const [busy, setBusy] = useState(false);
  const [assignmentTeam, setAssignmentTeam] = useState(""); const [assignmentPriority, setAssignmentPriority] = useState(""); const [priorityReason, setPriorityReason] = useState(""); const [priorityJustification, setPriorityJustification] = useState("");
  const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [product, setProduct] = useState(""); const [affectedService, setAffectedService] = useState(""); const [attachment, setAttachment] = useState<File | null>(null);
  const [comment, setComment] = useState(""); const [result, setResult] = useState<unknown>(null); const [query, setQuery] = useState(""); const [status, setStatus] = useState(""); const [priority, setPriority] = useState(""); const [teamId, setTeamId] = useState(""); const [sort, setSort] = useState("createdAt"); const [offset, setOffset] = useState(0); const [total, setTotal] = useState(0);
  const [activeTab, setActiveTab] = useState<"tickets" | "approvals" | "escalations">("tickets"); const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]); const [queueLoading, setQueueLoading] = useState(false);
  const [escalationQueue, setEscalationQueue] = useState<EscalationQueueItem[]>([]); const [escalationLoading, setEscalationLoading] = useState(false);
  const [workflowContext, setWorkflowContext] = useState<TicketWorkflowContext | null>(null); const [resolutionStatus, setResolutionStatus] = useState(""); const [resolutionDraft, setResolutionDraft] = useState(""); const [resolutionOutcome, setResolutionOutcome] = useState<"service_restored" | "agreed_solution">("service_restored"); const [customerConfirmation, setCustomerConfirmation] = useState<"received" | "not_applicable">("received"); const [customerConfirmationEvidence, setCustomerConfirmationEvidence] = useState(""); const [statusReason, setStatusReason] = useState("");
  const [escalationReason, setEscalationReason] = useState<"P1_CRITICAL" | "P2_HIGH" | "SLA_AT_RISK" | "BEYOND_AGENT_AUTHORITY" | "RECURRING_BREACH" | "OTHER">("BEYOND_AGENT_AUTHORITY"); const [handoverNotes, setHandoverNotes] = useState("");
  const refresh = useCallback(async () => { try { const page = await api.tickets({ q: query, status, priority, teamId, limit: 25, offset }); setTickets(page.data); setTotal(page.pagination.total); } catch (error) { onError(error); } }, [query, status, priority, teamId, offset, onError]);
  useEffect(() => { void refresh(); }, [refresh]);
  const refreshApprovalQueue = useCallback(async () => {
    if (!canApprove || !reviewerId) return;
    setQueueLoading(true);
    try {
      const tickets = await loadVisibleTickets();
      const pending: ReviewQueueItem[] = [];
      const failures: unknown[] = [];
      for (let start = 0; start < tickets.length; start += 8) {
        const batch = await Promise.allSettled(tickets.slice(start, start + 8).map(async ticket => ({ ticket, reports: (await api.triages(ticket.id)).data })));
        for (const result of batch) {
          if (result.status === "rejected") { failures.push(result.reason); continue; }
          for (const report of result.value.reports) {
            if (!report.redacted && !report.staleTicketSnapshot && !report.reviews.some(review => review.actorId === reviewerId)) pending.push({ ticket: result.value.ticket, report });
          }
        }
      }
      setReviewQueue(pending);
      if (failures.length) onError(failures[0]);
    } catch (error) {
      onError(error);
    } finally {
      setQueueLoading(false);
    }
  }, [canApprove, reviewerId, onError]);
  useEffect(() => { if (activeTab === "approvals") void refreshApprovalQueue(); }, [activeTab, refreshApprovalQueue]);
  const refreshEscalations = useCallback(async () => { if (!isLead) return; setEscalationLoading(true); try { setEscalationQueue((await api.escalations()).data); } catch (error) { onError(error); } finally { setEscalationLoading(false); } }, [isLead, onError]);
  useEffect(() => { if (activeTab === "escalations") void refreshEscalations(); }, [activeTab, refreshEscalations]);
  const open = async (ticket: SupportTicket) => { setBusy(true); setResult(null); setHistory([]); setAnalyses([]); setWorkflowContext(null); setResolutionDraft(""); setResolutionStatus(""); setAssignmentTeam(ticket.teamId ?? ""); setAssignmentPriority(ticket.priority ?? ""); setEscalationReason(ticket.priority === "P1" ? "P1_CRITICAL" : ticket.priority === "P2" ? "P2_HIGH" : "BEYOND_AGENT_AUTHORITY"); try { const detail = (await api.ticket(ticket.id)).data; setSelected(detail); if (canResolution) { try { const context = (await api.workflowContext(ticket.id)).data; setWorkflowContext(context); setResolutionStatus(context.transitions[0] ?? ""); } catch (error) { onError(error); } } if (canAudit) { try { setHistory((await api.ticketAudit(ticket.id)).data); } catch (error) { onError(error); } } if (canAi) { try { setAnalyses((await api.ticketAnalyses(ticket.id)).data); } catch (error) { onError(error); } } } catch (error) { onError(error); } finally { setBusy(false); } };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const productValue = product.trim();
      const affectedServiceValue = affectedService.trim();
      const item = (await api.createTicket({
        title: title.trim(),
        description: description.trim(),
        ...(productValue ? { product: productValue } : {}),
        ...(affectedServiceValue ? { affectedService: affectedServiceValue } : {}),
      })).data;
      setTitle("");
      setDescription("");
      setProduct("");
      setAffectedService("");
      if (attachment) {
        try {
          await api.uploadAttachment(item.id, attachment);
        } catch (error) {
          onError(error);
          onSuccess(`Ticket created (${item.id}), but the attachment could not be uploaded.`);
          setAttachment(null);
          await refresh();
          return;
        }
      }
      setAttachment(null);
      onSuccess("Ticket submitted successfully.");
      setOffset(0);
      await refresh();
      await open(item);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const downloadAttachment = async (attachmentId: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api.downloadAttachment(selected.id, attachmentId);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const addComment = async (event: React.FormEvent) => { event.preventDefault(); if (!selected || !comment.trim()) return; setBusy(true); try { await api.comment(selected.id, comment.trim(), "public"); setComment(""); await open(selected); } catch (error) { onError(error); } finally { setBusy(false); } };
  const run = async (action: "triage" | "analysis" | "priority" | "resolution" | "similar") => { if (!selected) return; setBusy(true); setResult(null); try { const response = action === "triage" ? await api.triage(selected.id) : action === "analysis" ? await api.analyze(selected.id) : action === "priority" ? await api.recommendPriority(selected.id) : action === "resolution" ? await api.recommendResolution(selected.id) : await api.similar(selected.id); if (action === "analysis") { setAnalyses(current => [response.data as TicketAnalysis, ...current]); setResult(null); } else setResult(response.data); if (action === "resolution") setResolutionDraft(resolutionText(response.data)); } catch (error) { onError(error); } finally { setBusy(false); } };
  const saveResolution = async () => { if (!selected || !resolutionStatus || !workflowContext) return; const isResolved = requiresResolutionEvidence(workflowContext, resolutionStatus); if (isResolved && (!resolutionDraft.trim() || !customerConfirmationEvidence.trim())) { onError(new Error("Record the resolution and customer-confirmation evidence before resolving this ticket.")); return; } setBusy(true); try { const body = { status: resolutionStatus, ...(statusReason.trim() ? { reason: statusReason.trim() } : {}), ...(isResolved ? { resolutionEvidence: { outcome: resolutionOutcome, note: resolutionDraft.trim(), customerConfirmation, customerConfirmationEvidence: customerConfirmationEvidence.trim() } } : {}) }; const updated = (await api.updateTicketStatus(selected.id, body)).data; setSelected(updated); setStatusReason(""); onSuccess(isResolved ? "Resolution outcome recorded and ticket status updated." : "Ticket status updated."); if (canAudit) setHistory((await api.ticketAudit(selected.id)).data); const context = (await api.workflowContext(selected.id)).data; setWorkflowContext(context); setResolutionStatus(context.transitions[0] ?? ""); } catch (error) { onError(error); } finally { setBusy(false); } };
  const escalate = async () => { if (!selected || !handoverNotes.trim()) return; const addingP1Handover = selected.escalations?.some(item => item.status === "open" && item.automatic && item.handoverNotes === AUTO_P1_HANDOVER) ?? false; setBusy(true); try { await api.openEscalation(selected.id, { reasonCode: escalationReason, handoverNotes: handoverNotes.trim() }); setHandoverNotes(""); await open(selected); await refreshEscalations(); onSuccess(addingP1Handover ? "P1 escalation handover notes recorded." : "Ticket escalated to the support lead queue."); } catch (error) { onError(error); } finally { setBusy(false); } };
  const closeEscalation = async (item: EscalationQueueItem, notes: string) => { setBusy(true); try { await api.resolveEscalation(item.ticket.id, item.escalation.id, notes); await refreshEscalations(); onSuccess("Escalation follow-up recorded."); } catch (error) { onError(error); } finally { setBusy(false); } };
  const review = async (item: ReviewQueueItem, decision: TriageReview["data"]["decision"], reason: string, editedResolution?: ReviewedResolution) => { setBusy(true); try { const result = (await api.reviewTriage(item.ticket.id, item.report.id, { decision, reason, ...(editedResolution ? { editedResolution } : {}) })).data; onSuccess(result.data.resolutionRevision ? "Review and edited resolution revision saved with a before/after audit record." : "Review decision saved with an audit record."); await refreshApprovalQueue(); } catch (error) { onError(error); } finally { setBusy(false); } };
  const saveTicketManagement = async () => { if (!selected) return; const body: Parameters<typeof api.updateTicket>[1] = {}; if (canRoute && assignmentTeam !== (selected.teamId ?? "")) body.teamId = assignmentTeam || null; if (canPrioritize && assignmentPriority && assignmentPriority !== selected.priority) { if (!priorityReason.trim() || !priorityJustification.trim()) { onError(new Error("Priority changes require a reason and business justification.")); return; } body.priority = assignmentPriority; body.priorityOverride = { reason: priorityReason.trim(), businessJustification: priorityJustification.trim() }; } if (Object.keys(body).length === 0) return; setBusy(true); try { const updated = (await api.updateTicket(selected.id, body)).data; setSelected(updated); setAssignmentTeam(updated.teamId ?? ""); setAssignmentPriority(updated.priority ?? ""); setPriorityReason(""); setPriorityJustification(""); onSuccess("Ticket updates saved."); if (canAudit) setHistory((await api.ticketAudit(selected.id)).data); } catch (error) { onError(error); } finally { setBusy(false); } };
  const sortedTickets = useMemo(() => [...tickets].sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : sort === "priority" ? (a.priority ?? "P5").localeCompare(b.priority ?? "P5") : b.createdAt.localeCompare(a.createdAt)), [tickets, sort]);
  const activeEscalation = selected?.escalations?.find(item => item.status === "open");
  const canAddP1Handover = activeEscalation?.automatic === true && activeEscalation.handoverNotes === AUTO_P1_HANDOVER;
  return <div className="support-workspace">
    {selected ? <>
      <button className="button button-secondary" onClick={() => { setSelected(null); setResult(null); }}> <ArrowLeft size={15} /> Back to tickets</button>
      <section className="content-card support-ticket-detail"><div className="section-heading"><div><span className="eyebrow">TICKET · {selected.id}</span><h2>{selected.title}</h2><p>{selected.status ?? "Open"} · {selected.priority ?? "Priority not set"} · Created {new Date(selected.createdAt).toLocaleString()}</p></div></div>
      <p className="support-description">{typeof selected.description === "string" ? selected.description : JSON.stringify(selected.description ?? "No description")}</p><div className="ticket-context"><span>Product: <strong>{selected.product || "Not specified"}</strong></span><span>Affected service: <strong>{selected.affectedService || "Not specified"}</strong></span><span>Responsible team: <strong>{teams.find(team => team.id === selected.teamId)?.name ?? (selected.teamId ? "Team assignment" : "Unassigned")}</strong></span></div>
      {(canRoute || canPrioritize) && <details className="content-card support-intake"><summary>Manage assignment and priority</summary><div className="ticket-management-form">{canRoute && <label className="field"><span className="field-label">Assigned team</span><select value={assignmentTeam} onChange={event => setAssignmentTeam(event.target.value)}><option value="">Unassigned</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}{canPrioritize && <><label className="field"><span className="field-label">Priority</span><select value={assignmentPriority} onChange={event => setAssignmentPriority(event.target.value)}><option value="">Keep current</option>{["P1","P2","P3","P4"].map(value => <option key={value}>{value}</option>)}</select></label>{assignmentPriority && assignmentPriority !== selected.priority && <><label className="field"><span className="field-label">Priority change reason</span><input value={priorityReason} onChange={event => setPriorityReason(event.target.value)} required/></label><label className="field"><span className="field-label">Business justification</span><input value={priorityJustification} onChange={event => setPriorityJustification(event.target.value)} required/></label></>}</>}<button className="button button-primary" disabled={busy} onClick={() => void saveTicketManagement()}>Save ticket updates</button></div></details>}
      {canEscalate && (!activeEscalation || canAddP1Handover) && <details className="content-card support-intake"><summary>{canAddP1Handover ? "Add required P1 handover notes" : "Escalate to support lead"}</summary><div className="support-intake-form"><p className="muted-copy">P1 incidents require immediate escalation. P2, SLA-risk, recurring-breach and beyond-authority cases can also be escalated. No automatic SLA threshold or external notification is assumed.</p>{!canAddP1Handover && <label className="field"><span className="field-label">Reason</span><select value={escalationReason} onChange={event => setEscalationReason(event.target.value as typeof escalationReason)}><option value="P1_CRITICAL">P1 critical incident</option><option value="P2_HIGH">P2 high-priority incident</option><option value="SLA_AT_RISK">SLA target at risk</option><option value="BEYOND_AGENT_AUTHORITY">Beyond my authority</option><option value="RECURRING_BREACH">Recurring SLA breach</option><option value="OTHER">Other</option></select></label>}<label className="field"><span className="field-label">Handover notes</span><textarea value={handoverNotes} onChange={event => setHandoverNotes(event.target.value)} required maxLength={4000} rows={3} placeholder="Impact, troubleshooting completed, current blockers, and the help needed"/></label><button className="button button-primary" disabled={busy || !handoverNotes.trim()} onClick={() => void escalate()}>{canAddP1Handover ? "Record P1 handover" : "Escalate ticket"}</button></div></details>}
      {(canAi || canResolution) && <div className="support-actions">{canAi && <><button className="button button-primary" disabled={busy} onClick={() => void run("analysis")}><Sparkles size={15}/> Analyze ticket</button><button className="button button-secondary" disabled={busy} onClick={() => void run("triage")}>Full AI triage</button><button className="button button-secondary" disabled={busy} onClick={() => void run("priority")}>Preview priority</button></>}{canResolution && <><button className="button button-secondary" disabled={busy} onClick={() => void run("similar")}>Similar tickets & knowledge</button><button className="button button-secondary" disabled={busy} onClick={() => void run("resolution")}>Resolution workspace</button></>}</div>}
      {analyses[0] && <section className="ai-summary-panel"><div className="eyebrow">AI-GENERATED SUMMARY · {new Date(analyses[0].createdAt).toLocaleString()}</div><h3>{analyses[0].summary.summary}</h3>{analyses[0].summary.affectedFunctionality && <p><strong>Affected functionality:</strong> {analyses[0].summary.affectedFunctionality}</p>}{analyses[0].summary.businessImpact && <p><strong>Business impact:</strong> {analyses[0].summary.businessImpact}</p>}<div className="ai-summary-columns"><BulletList title="Symptoms" values={analyses[0].summary.symptoms}/><BulletList title="Attempted actions" values={analyses[0].summary.attemptedActions}/><BulletList title="Missing information" values={analyses[0].summary.missingInformation}/></div><p className="ai-classification"><strong>Category:</strong> {analyses[0].classification.category ?? "Uncertain"} · <strong>Confidence:</strong> {analyses[0].classification.confidence === null ? "Unavailable" : `${Math.round(analyses[0].classification.confidence * 100)}%`} {analyses[0].classification.requiresHumanReview && "· Human review required"}</p></section>}
      {result !== null && <AiRecommendationPanel value={result} teams={teams}/ >}
      {canResolution && workflowContext && workflowContext.transitions.length > 0 && <section className="content-card resolution-workspace"><div><span className="eyebrow">HUMAN RESOLUTION</span><h3>Review and update ticket</h3><p className="muted-copy">Edit the suggested resolution as needed. The server validates allowed status transitions and records the final outcome in ticket history.</p></div><label className="field"><span className="field-label">Next status</span><select value={resolutionStatus} onChange={event => setResolutionStatus(event.target.value)}>{workflowContext.transitions.map(status => <option key={status} value={status}>{status}</option>)}</select></label><label className="field"><span className="field-label">Resolution / work notes</span><textarea value={resolutionDraft} onChange={event => setResolutionDraft(event.target.value)} maxLength={4000} rows={5} placeholder="Document the verified work and outcome. You can edit the AI suggestion above."/></label>{requiresResolutionEvidence(workflowContext, resolutionStatus) && <><label className="field"><span className="field-label">Outcome</span><select value={resolutionOutcome} onChange={event => setResolutionOutcome(event.target.value as typeof resolutionOutcome)}><option value="service_restored">Service restored</option><option value="agreed_solution">Agreed solution implemented</option></select></label><label className="field"><span className="field-label">Customer confirmation</span><select value={customerConfirmation} onChange={event => setCustomerConfirmation(event.target.value as typeof customerConfirmation)}><option value="received">Received</option><option value="not_applicable">Not applicable</option></select></label><label className="field"><span className="field-label">Customer confirmation evidence</span><textarea value={customerConfirmationEvidence} onChange={event => setCustomerConfirmationEvidence(event.target.value)} required maxLength={2000} rows={2} placeholder="Record confirmation or why it is not applicable"/></label></>}<label className="field"><span className="field-label">Transition reason (when applicable)</span><input value={statusReason} onChange={event => setStatusReason(event.target.value)} maxLength={2000}/></label><button className="button button-primary" disabled={busy || !resolutionStatus || (requiresResolutionEvidence(workflowContext, resolutionStatus) && (!resolutionDraft.trim() || !customerConfirmationEvidence.trim()))} onClick={() => void saveResolution()}>{requiresResolutionEvidence(workflowContext, resolutionStatus) ? "Record resolution and update status" : "Update ticket status"}</button></section>}
      {selected.attachments?.length ? <section className="support-comments"><h3>Attachments</h3>{selected.attachments.map(file => <p key={file.id}>{file.fileName} · {Math.ceil(file.fileSizeBytes / 1024)} KB <button className="text-action" disabled={busy} onClick={() => void downloadAttachment(file.id)}><Download size={14}/> Download</button></p>)}</section> : null}
      {canAudit && <section className="support-comments"><h3>Ticket history</h3>{history.length ? history.map(item => <article className="support-comment" key={item.id}><p><strong>{item.action.replaceAll("_", " ")}</strong> · {new Date(item.createdAt).toLocaleString()}</p><small>{JSON.stringify(item.changes)}</small></article>) : <p>No recorded ticket history.</p>}</section>}
      <div className="support-comments"><h3>Conversation</h3>{(selected.comments ?? []).map(item => <article className="support-comment" key={item.id}><p>{item.body}</p><small>{item.visibility} · {new Date(item.createdAt).toLocaleString()}</small></article>)}{canComment && <form onSubmit={event => void addComment(event)} className="support-intake-form"><label className="field"><span className="field-label">Reply</span><textarea value={comment} onChange={event => setComment(event.target.value)} required rows={3}/></label><button className="button button-primary" disabled={busy || !comment.trim()}>Add public comment</button></form>}</div></section>
    </> : <>
      <div className="support-toolbar"><div><span className="eyebrow">SUPPORT WORKSPACE</span><h2>{activeTab === "approvals" ? "AI approval queue" : activeTab === "escalations" ? "Escalated tickets" : canCreate ? "Your tickets" : isLead ? "Team & unassigned queue" : "Assigned tickets"}</h2><p>{activeTab === "approvals" ? "Review AI triage recommendations for tickets in your authorised scope." : activeTab === "escalations" ? "Follow up on critical and manually escalated incidents in your team scope." : isLead ? "Tickets assigned to your active teams and tickets awaiting team assignment." : "Ticket visibility and access are enforced by the backend for your active role."}</p></div>{activeTab === "tickets" && <label className="search-box"><Activity size={16}/><input aria-label="Search tickets" placeholder="Search tickets" value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }}/></label>}</div>
      {isLead && <div className="support-tabs" role="tablist" aria-label="Support lead queues"><button role="tab" aria-selected={activeTab === "tickets"} className={activeTab === "tickets" ? "support-tab-active" : ""} onClick={() => setActiveTab("tickets")}>Team & unassigned</button><button role="tab" aria-selected={activeTab === "escalations"} className={activeTab === "escalations" ? "support-tab-active" : ""} onClick={() => setActiveTab("escalations")}>Escalations <span className="nav-count">{escalationQueue.length}</span></button><button role="tab" aria-selected={activeTab === "approvals"} className={activeTab === "approvals" ? "support-tab-active" : ""} onClick={() => setActiveTab("approvals")}>AI approvals <span className="nav-count">{reviewQueue.length}</span></button></div>}
      {activeTab === "escalations" && isLead ? <section className="content-card"><div className="section-heading"><div><h2>Open escalations</h2><p>These are tickets explicitly escalated by support staff. SLA warning thresholds and outbound notices are not inferred from draft policy.</p></div><button className="icon-button" aria-label="Refresh escalations" onClick={() => void refreshEscalations()}><Activity size={16}/></button></div>{escalationLoading ? <div className="loading-line"><LoaderCircle size={16} className="spin"/> Loading escalations…</div> : escalationQueue.length ? <div className="approval-queue">{escalationQueue.map(item => <EscalationCard key={item.escalation.id} item={item} canResolve={canResolveEscalation} busy={busy} onOpen={() => void open(item.ticket)} onResolve={notes => void closeEscalation(item, notes)}/>)}</div> : <div className="empty-state"><strong>No open escalations</strong><p>Tickets escalated within your authorised team scope appear here.</p></div>}</section> : null}
      {activeTab === "approvals" && isLead ? <section className="content-card"><div className="section-heading"><div><h2>AI recommendations awaiting your review</h2><p>Only reports for tickets in your team and unassigned scope are checked. A review stores the decision and comment, plus an optional edited resolution revision with before/after audit values. It does not change ticket state.</p></div><button className="icon-button" aria-label="Refresh approval queue" onClick={() => void refreshApprovalQueue()}><Activity size={16}/></button></div>{queueLoading ? <div className="loading-line"><LoaderCircle size={16} className="spin"/> Loading review queue…</div> : reviewQueue.length ? <div className="approval-queue">{reviewQueue.map(item => <ApprovalCard key={item.report.id} item={item} busy={busy} onReview={(decision, reason, edit) => void review(item, decision, reason, edit)}/>)}</div> : <div className="empty-state"><strong>No AI recommendations awaiting your review</strong><p>Run AI triage on an accessible team ticket to create a reviewable recommendation.</p></div>}</section> : activeTab === "tickets" && <>
      {canCreate && <details className="content-card support-intake"><summary><Plus size={16}/> Create a support ticket</summary><form onSubmit={event => void create(event)} className="support-intake-form">
        <p className="muted-copy">Requester: <strong>{requesterDisplayName || "Signed-in account"}</strong>{requesterEmail ? ` (${requesterEmail})` : ""}. This identity is verified by the backend and recorded as the requester.</p>
        <label className="field"><span className="field-label">Title</span><input value={title} onChange={event => setTitle(event.target.value)} required maxLength={200} autoComplete="off"/></label>
        <label className="field"><span className="field-label">Description</span><textarea value={description} onChange={event => setDescription(event.target.value)} required rows={4}/></label>
        <label className="field"><span className="field-label">Product (optional)</span><input value={product} onChange={event => setProduct(event.target.value)} maxLength={200} autoComplete="off"/></label>
        <label className="field"><span className="field-label">Affected service (optional)</span><input value={affectedService} onChange={event => setAffectedService(event.target.value)} maxLength={200} autoComplete="off"/></label>
        <label className="field"><span className="field-label">Attachment (optional)</span><input type="file" accept=".pdf,.txt,.doc,.docx,.jpg,.jpeg,.png,.webp" onChange={event => setAttachment(event.target.files?.[0] ?? null)}/></label>
        {attachment && <small className="muted-copy">Selected: {attachment.name} ({Math.ceil(attachment.size / 1024)} KB)</small>}
        <button className="button button-primary" disabled={busy || !title.trim() || !description.trim()}>{busy ? <LoaderCircle size={15} className="spin"/> : <Plus size={15}/>} Submit ticket</button>
      </form></details>}
      <section className="content-card"><div className="section-heading"><div><h2>Tickets</h2><p>{total} visible to your account · page {Math.floor(offset / 25) + 1}</p></div><button className="icon-button" aria-label="Refresh tickets" onClick={() => void refresh()}><Activity size={16}/></button></div>
      <div className="ticket-filters"><label className="field"><span className="field-label">Status</span><input value={status} placeholder="Any status" onChange={event => { setStatus(event.target.value); setOffset(0); }}/></label><label className="field"><span className="field-label">Priority</span><select value={priority} onChange={event => { setPriority(event.target.value); setOffset(0); }}><option value="">Any priority</option>{["P1","P2","P3","P4"].map(value => <option key={value}>{value}</option>)}</select></label>{teams.length > 0 && <label className="field"><span className="field-label">Team</span><select value={teamId} onChange={event => { setTeamId(event.target.value); setOffset(0); }}><option value="">Any team</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}<label className="field"><span className="field-label">Sort this page</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="createdAt">Newest</option><option value="title">Title</option><option value="priority">Priority</option></select></label></div>
      {tickets.length ? <div className="support-ticket-list">{sortedTickets.map(ticket => <button className="support-ticket-row" key={ticket.id} onClick={() => void open(ticket)}><span><strong>{ticket.title}</strong><small>{ticket.id} · {ticket.affectedService ?? ticket.product ?? "Service not specified"} · {new Date(ticket.createdAt).toLocaleString()}</small></span><span className="support-ticket-meta">{ticket.priority ?? "Priority unset"}<br/>{ticket.status ?? "Open"}</span></button>)}</div> : <div className="empty-state"><strong>No visible tickets yet</strong><p>Tickets appear here when they are available to your account.</p></div>}<div className="ticket-page-controls"><button className="button button-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</button><span>{total ? `${offset + 1}–${Math.min(total, offset + 25)} of ${total}` : "0 tickets"}</span><button className="button button-secondary" disabled={offset + 25 >= total} onClick={() => setOffset(offset + 25)}>Next</button></div></section>
      </>}
    </>}
    {busy && <span className="sr-only" role="status">Working</span>}
  </div>;
}

function ApprovalCard({ item, busy, onReview }: { item: ReviewQueueItem; busy: boolean; onReview: (decision: TriageReview["data"]["decision"], reason: string, edited?: ReviewedResolution) => void }) {
  const [decision, setDecision] = useState<TriageReview["data"]["decision"]>("accepted");
  const [reason, setReason] = useState("");
  const original = resolutionForReview(item.report.data.result);
  const [resolutionJson, setResolutionJson] = useState(() => original ? JSON.stringify(original, null, 2) : "");
  let edited: ReviewedResolution | null = null;
  if (resolutionJson.trim()) { try { edited = JSON.parse(resolutionJson) as ReviewedResolution; } catch { edited = null; } }
  const changed = !!original && !!edited && JSON.stringify(original) !== JSON.stringify(edited);
  const validEdit = !resolutionJson.trim() || !!edited;
  return <article className="approval-card"><div className="approval-card-heading"><div><strong>{item.ticket.title}</strong><small>{item.ticket.id} · {item.ticket.priority ?? "Priority unset"}</small></div><span className="status-badge status-muted"><span/>Awaiting your review</span></div>
    <details><summary>View AI recommendation and evidence</summary><pre className="support-ai-result">{JSON.stringify(item.report.data.result, null, 2)}</pre></details>
    {original && <details className="resolution-edit-workspace"><summary>Edit suggested resolution (optional)</summary><p className="muted-copy">Edit the summary or ordered steps in the structured JSON. Keep citations attached to each step; the server validates every citation against the report’s approved evidence. Saving creates an immutable before/after revision.</p><label className="field"><span className="field-label">Reviewer-edited resolution JSON</span><textarea rows={Math.min(18, Math.max(8, resolutionJson.split("\n").length))} spellCheck={false} value={resolutionJson} onChange={event => setResolutionJson(event.target.value)}/></label>{!validEdit && <p className="config-error" role="alert">Enter valid JSON before submitting the review.</p>}{changed && <p className="config-notice" role="status">An edited resolution revision will be recorded with this review.</p>}</details>}
    <form className="approval-review-form" onSubmit={event => { event.preventDefault(); if (reason.trim()) onReview(decision, reason.trim(), changed ? edited ?? undefined : undefined); }}><label className="field"><span className="field-label">Decision</span><select value={decision} onChange={event => setDecision(event.target.value as TriageReview["data"]["decision"])}><option value="accepted">Approve recommendation</option><option value="rejected">Reject recommendation</option><option value="needs_information">Request changes / more information</option></select></label><label className="field"><span className="field-label">Reviewer comment</span><textarea required maxLength={2000} rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain your decision"/></label><button className="button button-primary" disabled={busy || !reason.trim() || !validEdit}>Submit review</button></form></article>;
}
function resolutionForReview(value: unknown): ReviewedResolution | null {
  const result = objectValue(value); const capability = objectValue(result?.resolution); const data = objectValue(capability?.data);
  if (capability?.status !== "completed" || !data || typeof data.summary !== "string" || !Array.isArray(data.steps)) return null;
  const steps: ReviewedResolution["steps"] = data.steps.flatMap((stepValue): ReviewedResolution["steps"] => {
    const step = objectValue(stepValue); if (!step || typeof step.instruction !== "string" || !Array.isArray(step.citations)) return [];
    const citations = step.citations.flatMap((citationValue): ReviewedResolution["steps"][number]["citations"] => {
      const citation = objectValue(citationValue); return typeof citation?.passageId === "string" && typeof citation.excerpt === "string" ? [{ passageId: citation.passageId, excerpt: citation.excerpt }] : [];
    });
    return [{ instruction: step.instruction, citations }];
  });
  const strings = (input: unknown) => Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
  return { summary: data.summary, steps, missingInformation: strings(data.missingInformation), warnings: strings(data.warnings) };
}
function EscalationCard({ item, canResolve, busy, onOpen, onResolve }: { item: EscalationQueueItem; canResolve: boolean; busy: boolean; onOpen: () => void; onResolve: (notes: string) => void }) {
  const [notes, setNotes] = useState("");
  const label: Record<typeof item.escalation.reasonCode, string> = { P1_CRITICAL: "P1 Critical", P2_HIGH: "P2 High", SLA_AT_RISK: "SLA at risk", BEYOND_AGENT_AUTHORITY: "Beyond agent authority", RECURRING_BREACH: "Recurring SLA breach", OTHER: "Other" };
  return <article className="approval-card"><div className="approval-card-heading"><div><button type="button" className="text-action" onClick={onOpen}>{item.ticket.title}</button><small>{item.ticket.id} · {item.ticket.priority ?? "Priority unset"} · {item.ticket.status ?? "Open"}</small></div><span className="status-badge status-danger"><span/>{label[item.escalation.reasonCode]}</span></div><p className="escalation-handover">{item.escalation.handoverNotes}</p><small className="muted-copy">Escalated {new Date(item.escalation.escalatedAt).toLocaleString()} by {item.escalation.escalatedBy}{item.escalation.automatic ? " · automatically opened when priority became P1" : ""}</small>{canResolve && <form className="escalation-resolve-form" onSubmit={event => { event.preventDefault(); if (notes.trim()) onResolve(notes.trim()); }}><label className="field"><span className="field-label">Lead follow-up / outcome</span><textarea value={notes} onChange={event => setNotes(event.target.value)} required maxLength={4000} rows={2}/></label><button className="button button-secondary" disabled={busy || !notes.trim()}>Record follow-up and close escalation</button></form>}</article>;
}

function BulletList({ title, values }: { title: string; values: string[] }) { return <div><strong>{title}</strong>{values.length ? <ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul> : <p className="muted-copy">None recorded</p>}</div>; }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function capabilityData(value: unknown): Record<string, unknown> | null {
  const object = objectValue(value);
  return objectValue(object?.data) ?? object;
}

function AiRecommendationPanel({ value, teams }: { value: unknown; teams: { id: string; name: string }[] }) {
  const root = objectValue(value);
  const core = objectValue(root?.core);
  const classification = objectValue(core?.classification);
  const summary = objectValue(core?.summary);
  const priority = capabilityData(root?.priority) ?? (root && "factors" in root ? root : null);
  const routing = capabilityData(root?.routing);
  const resolution = capabilityData(root?.resolution) ?? (root && "steps" in root ? root : null);
  const evidenceResult = objectValue(root?.evidence);
  const passages = Array.isArray(value) ? value : Array.isArray(evidenceResult?.data) ? evidenceResult.data : [];
  const classificationEvidence = Array.isArray(classification?.evidence) ? classification.evidence : [];
  const factors = priority ? ["impact", "urgency"].map(key => [key, objectValue(priority[key])] as const).filter((item): item is readonly [string, Record<string, unknown>] => item[1] !== null) : [];
  const steps = Array.isArray(resolution?.steps) ? resolution.steps : [];
  const hasStructuredContent = !!(classification || summary || priority || routing || resolution || passages.length);
  return <section className="ai-result-panel"><h3>AI recommendations and evidence</h3>
    {classification && <article className="ai-result-section"><h4>Classification</h4><p><strong>Categories:</strong> {Array.isArray(classification.categories) && classification.categories.length ? classification.categories.filter((item): item is string => typeof item === "string").join(", ") : "Uncertain"}</p><p><strong>Confidence:</strong> {typeof classification.confidence === "number" ? `${Math.round(classification.confidence * 100)}%` : "Unavailable"}{classification.requiresHumanReview === true ? " · Human review required" : ""}</p>{typeof classification.reason === "string" && <p>{classification.reason}</p>}{classificationEvidence.length > 0 && <ul>{classificationEvidence.map((item, index) => { const evidence = objectValue(item); return evidence ? <li key={`class-evidence-${index}`}><q>{String(evidence.excerpt ?? "")}</q> <span className="muted-copy">({String(evidence.field ?? "ticket")})</span></li> : null; })}</ul>}</article>}
    {summary && <article className="ai-result-section"><h4>Issue summary</h4><p>{typeof summary.summary === "string" ? summary.summary : "No summary returned."}</p>{typeof summary.affectedFunctionality === "string" && <p><strong>Affected functionality:</strong> {summary.affectedFunctionality}</p>}{typeof summary.businessImpact === "string" && <p><strong>Customer impact:</strong> {summary.businessImpact}</p>}</article>}
    {priority && <article className="ai-result-section"><h4>Priority recommendation</h4><p><strong>Suggested priority:</strong> {typeof priority.priority === "string" ? priority.priority : "Not determined"} · {typeof priority.status === "string" ? priority.status.replaceAll("_", " ") : "review required"}</p>{factors.map(([name, factor]) => <div key={name}><strong>{name === "impact" ? "Impact" : "Urgency"}:</strong> {typeof factor.value === "string" ? factor.value : "Insufficient evidence"}{typeof factor.confidence === "number" ? ` · ${Math.round(factor.confidence * 100)}% confidence` : " · confidence unavailable"}{typeof factor.reason === "string" && <p>{factor.reason}</p>}{Array.isArray(factor.evidence) && factor.evidence.map((item, index) => { const citation = objectValue(item); return citation && typeof citation.excerpt === "string" ? <p key={`${name}-evidence-${index}`}><q>{citation.excerpt}</q></p> : null; })}</div>)}</article>}
    {routing && <article className="ai-result-section"><h4>Suggested responsible team</h4><p>{typeof routing.teamId === "string" ? teams.find(team => team.id === routing.teamId)?.name ?? routing.teamId : "No unambiguous team recommendation"}{typeof routing.status === "string" ? ` · ${routing.status.replaceAll("_", " ")}` : ""} · human review required</p></article>}
    {passages.length > 0 && <article className="ai-result-section"><h4>Similar tickets and knowledge</h4>{passages.map((item, index) => { const passage = objectValue(item); return passage ? <div className="ai-evidence-card" key={String(passage.passageId ?? passage.sourceId ?? index)}><strong>{String(passage.title ?? passage.sourceType ?? "Source")}</strong><small>Source {String(passage.sourceId ?? "unknown")} · version {String(passage.version ?? "unknown")}</small>{typeof passage.excerpt === "string" && <p>{passage.excerpt}</p>}</div> : null; })}</article>}
    {resolution && <article className="ai-result-section"><h4>Evidence-backed resolution</h4>{typeof resolution.summary === "string" && <p>{resolution.summary}</p>}{steps.length ? <ol>{steps.map((item, index) => { const step = objectValue(item); return step ? <li key={`resolution-step-${index}`}>{String(step.instruction ?? "")}{Array.isArray(step.citations) && <ul>{step.citations.map((citation, citationIndex) => { const reference = objectValue(citation); return reference && typeof reference.excerpt === "string" ? <li key={`citation-${index}-${citationIndex}`}><q>{reference.excerpt}</q></li> : null; })}</ul>}</li> : null; })}</ol> : <p className="muted-copy">No supported resolution steps were returned.</p>}</article>}
    {!hasStructuredContent && <p className="muted-copy">The backend returned no displayable recommendation fields.</p>}
    <details><summary>Technical response</summary><pre className="support-ai-result">{JSON.stringify(value, null, 2)}</pre></details>
  </section>;
}

function resolutionText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const result = value as { summary?: unknown; steps?: unknown; missingInformation?: unknown };
  const sections: string[] = [];
  if (typeof result.summary === "string") sections.push(result.summary);
  if (Array.isArray(result.steps)) {
    const steps = result.steps.flatMap(step => step && typeof step === "object" && typeof (step as { instruction?: unknown }).instruction === "string" ? [`- ${(step as { instruction: string }).instruction}`] : []);
    if (steps.length) sections.push(`Recommended steps:\n${steps.join("\n")}`);
  }
  if (Array.isArray(result.missingInformation)) {
    const missing = result.missingInformation.filter((item): item is string => typeof item === "string");
    if (missing.length) sections.push(`Missing information:\n${missing.map(item => `- ${item}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

function requiresResolutionEvidence(context: TicketWorkflowContext, nextStatus: string): boolean {
  return context.resolvedStatuses.includes(nextStatus) && !context.resolvedStatuses.includes(context.currentStatus ?? "");
}
