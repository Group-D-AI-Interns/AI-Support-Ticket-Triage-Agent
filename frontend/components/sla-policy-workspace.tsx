"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Check, FileText, RefreshCw, Upload } from "lucide-react";
import { api, type ExtractedRule, type SlaPolicyRecord, type TenantDocument, type TenantDocumentVersion } from "@/lib/api";

type Props = { canAdmin: boolean; onError: (error: unknown) => void };
const localDateTime = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

export function SlaPolicyWorkspace({ canAdmin, onError }: Props) {
  const [documents, setDocuments] = useState<TenantDocument[]>([]);
  const [rules, setRules] = useState<ExtractedRule[]>([]);
  const [policies, setPolicies] = useState<SlaPolicyRecord[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [versions, setVersions] = useState<TenantDocumentVersion[]>([]);
  const [sourceVersionId, setSourceVersionId] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [selectedRules, setSelectedRules] = useState<string[]>([]);
  const [publicationReason, setPublicationReason] = useState("");
  const [publicationFrom, setPublicationFrom] = useState(() => localDateTime(new Date()));
  const [publicationTo, setPublicationTo] = useState("");
  const [visibility, setVisibility] = useState<"support_staff" | "administrators">("support_staff");
  const [slaDescription, setSlaDescription] = useState("");
  const [slaFrom, setSlaFrom] = useState(() => localDateTime(new Date()));
  const [slaTo, setSlaTo] = useState("");
  const [slaPayload, setSlaPayload] = useState("");
  const [approvalReasons, setApprovalReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [documentsResult, rulesResult, policiesResult] = await Promise.allSettled([
      api.documents(), api.extractedRules(), api.slaPolicies(),
    ]);
    const nextErrors: string[] = [];
    if (documentsResult.status === "fulfilled") setDocuments(documentsResult.value.data);
    else { nextErrors.push(`Documents: ${errorMessage(documentsResult.reason)}`); onError(documentsResult.reason); }
    if (rulesResult.status === "fulfilled") setRules(rulesResult.value.data);
    else { nextErrors.push(`Extracted rules: ${errorMessage(rulesResult.reason)}`); onError(rulesResult.reason); }
    if (policiesResult.status === "fulfilled") setPolicies(policiesResult.value.data as SlaPolicyRecord[]);
    else { nextErrors.push(`SLA policies: ${errorMessage(policiesResult.reason)}`); onError(policiesResult.reason); }
    setErrors(nextErrors);
    setLoading(false);
  }, [onError]);

  useEffect(() => { if (canAdmin) void load(); }, [canAdmin, load]);

  const selectedDocument = documents.find(document => document.id === selectedDocumentId);
  const documentRules = useMemo(() => rules.filter(rule => rule.documentId === selectedDocumentId), [rules, selectedDocumentId]);
  const approvedRules = documentRules.filter(rule => rule.reviewStatus === "approved");

  async function act(key: string, work: () => Promise<void>) {
    setBusy(key); setMessage("");
    try { await work(); }
    catch (error) { setMessage(errorMessage(error)); onError(error); }
    finally { setBusy(""); }
  }

  async function chooseDocument(id: string) {
    setSelectedDocumentId(id); setSelectedRules([]); setVersions([]); setSourceVersionId("");
    if (!id) return;
    try {
      const detail = await api.document(id);
      setVersions(detail.data.versions);
      setSourceVersionId(detail.data.versions.find(item => item.version === detail.data.document.version)?.id ?? "");
      const document = detail.data.document;
      setSlaDescription(`SLA policy based on ${document.title}`);
    } catch (error) { setMessage(errorMessage(error)); onError(error); }
  }

  if (!canAdmin) return <section className="content-card"><h3>SLA documents and policies</h3><p className="muted-copy">Organisation administrator access is required to upload documents, review extracted policy evidence, and manage SLA policy versions.</p></section>;

  return <section className="sla-admin-workspace">
    <div className="support-toolbar"><div><span className="eyebrow">AI KNOWLEDGE & SLA</span><h2>Policy documents</h2><p>Upload an SLA source, review extracted evidence, then publish approved knowledge or configure an SLA version. Uploading never activates policy automatically.</p></div><button className="button button-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={14}/> Refresh</button></div>
    {errors.length > 0 && <div className="config-error">Some policy data could not be loaded: {errors.join(" · ")}</div>}
    {message && <div className="config-notice" role="status">{message}</div>}
    <div className="ops-columns">
      <section className="content-card">
        <h3>Upload an SLA or policy document</h3>
        <p className="muted-copy">Supported source formats are TXT, Markdown, PDF and DOCX. Files are stored in this organisation’s private document area.</p>
        <form className="policy-form" onSubmit={event => { event.preventDefault(); if (!file) { setMessage("Choose a document file first."); return; } void act("upload", async () => { const result = await api.uploadDocument(uploadTitle.trim(), file); setSelectedDocumentId(result.data.document.id); setUploadTitle(""); setFile(null); setMessage("Document uploaded. Review it and run extraction when ready."); await load(); const detail = await api.document(result.data.document.id); setVersions(detail.data.versions); setSourceVersionId(detail.data.versions.find(item => item.version === detail.data.document.version)?.id ?? ""); }); }}>
          <label className="field"><span>Document title</span><input required maxLength={200} value={uploadTitle} onChange={event => setUploadTitle(event.target.value)} placeholder="e.g. Approved support SLA"/></label>
          <label className="field"><span>Source file</span><input required type="file" accept=".txt,.md,.pdf,.docx" onChange={event => setFile(event.target.files?.[0] ?? null)}/></label>
          <button className="button button-primary" type="submit" disabled={!!busy}>{busy === "upload" ? <Activity size={14}/> : <Upload size={14}/>} Upload document</button>
        </form>
      </section>
      <section className="content-card">
        <h3>Uploaded documents</h3>
        {loading ? <p className="muted-copy">Loading documents…</p> : documents.length ? <div className="policy-document-list">{documents.map(document => <button type="button" key={document.id} className={`policy-document-row${document.id === selectedDocumentId ? " selected" : ""}`} onClick={() => void chooseDocument(document.id)}><FileText size={16}/><span><strong>{document.title}</strong><small>{document.fileName} · v{document.version} · {document.status}/{document.processingStatus}</small></span></button>)}</div> : <p className="muted-copy">No documents uploaded for this organisation.</p>}
      </section>
    </div>

    {selectedDocument && <section className="content-card policy-review-card">
      <div className="policy-section-heading"><div><h3>Review source: {selectedDocument.title}</h3><p className="muted-copy">Extraction creates candidate evidence only. Review each candidate before using it.</p></div><button className="button button-secondary" disabled={!!busy} onClick={() => void act("extract", async () => { const result = await api.extractDocumentRules(selectedDocument.id); setMessage(`Extraction ${String(result.data.job.status ?? "finished")}. Review the candidates below.`); await load(); })}>{busy === "extract" ? <Activity size={14}/> : <FileText size={14}/>} Extract policy evidence</button></div>
      {documentRules.length ? <div className="candidate-list">{documentRules.map(rule => <article className="candidate-rule" key={rule.id}>
        <div className="policy-section-heading"><strong>{rule.ruleType.replaceAll("_", " ")}</strong><span className={`policy-status policy-status-${rule.reviewStatus ?? "pending_review"}`}>{(rule.reviewStatus ?? "pending_review").replaceAll("_", " ")}</span></div>
        <details><summary>Candidate and source evidence{rule.confidence === null ? "" : ` · confidence ${Math.round(rule.confidence * 100)}%`}</summary><pre className="support-ai-result">{JSON.stringify({ payload: rule.payload, evidence: rule.evidence, warnings: rule.warnings }, null, 2)}</pre></details>
        {rule.reviewStatus === "pending_review" && <div className="policy-review-actions"><label className="field"><span>Review reason</span><input value={reviewReasons[rule.id] ?? ""} onChange={event => setReviewReasons(current => ({ ...current, [rule.id]: event.target.value }))} placeholder="Explain your decision"/></label><button className="button button-primary" disabled={!!busy || !(reviewReasons[rule.id] ?? "").trim()} onClick={() => void act(`approve-${rule.id}`, async () => { await api.approveExtractedRule(rule.id, reviewReasons[rule.id]!.trim()); setSelectedRules(current => [...new Set([...current, rule.id])]); await load(); })}><Check size={14}/> Approve</button><button className="button button-secondary" disabled={!!busy || !(reviewReasons[rule.id] ?? "").trim()} onClick={() => void act(`reject-${rule.id}`, async () => { await api.rejectExtractedRule(rule.id, reviewReasons[rule.id]!.trim()); setSelectedRules(current => current.filter(id => id !== rule.id)); await load(); })}>Reject</button></div>}
      </article>)}</div> : <p className="muted-copy">No extracted candidates for this document. Run extraction after upload.</p>}
      {approvedRules.length > 0 && <details className="policy-publish-panel"><summary>Publish approved evidence for AI retrieval</summary><p className="muted-copy">Published evidence can support authorised similar-ticket and resolution retrieval. It does not change the priority matrix or activate SLA targets.</p><div className="candidate-select-list">{approvedRules.map(rule => <label key={rule.id}><input type="checkbox" checked={selectedRules.includes(rule.id)} onChange={event => setSelectedRules(current => event.target.checked ? [...new Set([...current, rule.id])] : current.filter(id => id !== rule.id))}/><span>{rule.ruleType.replaceAll("_", " ")} <small>{rule.id}</small></span></label>)}</div><div className="policy-form policy-form-two"><label className="field"><span>Publication reason</span><input value={publicationReason} onChange={event => setPublicationReason(event.target.value)} placeholder="Why this evidence is approved for staff use"/></label><label className="field"><span>Visible to</span><select value={visibility} onChange={event => setVisibility(event.target.value as typeof visibility)}><option value="support_staff">Support staff</option><option value="administrators">Administrators only</option></select></label><label className="field"><span>Effective from</span><input type="datetime-local" value={publicationFrom} onChange={event => setPublicationFrom(event.target.value)}/></label><label className="field"><span>Effective to (optional)</span><input type="datetime-local" value={publicationTo} onChange={event => setPublicationTo(event.target.value)}/></label></div><button className="button button-primary" disabled={!!busy || !selectedRules.length || !publicationReason.trim() || !publicationFrom} onClick={() => void act("publish", async () => { await api.publishDocumentKnowledge(selectedDocument.id, { ruleIds: selectedRules, reason: publicationReason.trim(), effectiveFrom: new Date(publicationFrom).toISOString(), effectiveTo: publicationTo ? new Date(publicationTo).toISOString() : null, visibility }); setMessage("Approved document evidence is now published for the selected audience."); setSelectedRules([]); })}>Publish approved evidence</button></details>}
    </section>}

    {selectedDocument && <section className="content-card">
      <h3>Configure SLA targets from the reviewed contract</h3>
      <p className="muted-copy">Enter the tenant-approved values from the contract. The server validates the full policy schema; a new version remains pending until explicitly approved and activated.</p>
      <form className="policy-form" onSubmit={event => { event.preventDefault(); void act("create-sla", async () => { let payload: Record<string, unknown>; try { payload = JSON.parse(slaPayload) as Record<string, unknown>; if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error(); } catch { throw new Error("SLA policy JSON must be a valid object."); } const sourceVersion = versions.find(item => item.version === selectedDocument.version); if (!sourceVersion) throw new Error("Could not find the current uploaded document version."); await api.createSlaPolicy({ description: slaDescription.trim(), sourceDocumentId: selectedDocument.id, sourceDocumentVersionId: sourceVersion.id, effectiveFrom: new Date(slaFrom).toISOString(), effectiveTo: slaTo ? new Date(slaTo).toISOString() : null, payload }); setSlaPayload(""); setMessage("SLA policy version created as pending approval; it is not active yet."); await load(); }); }}>
      <div className="policy-form policy-form-two"><label className="field"><span>Policy description</span><input required value={slaDescription} onChange={event => setSlaDescription(event.target.value)} placeholder="Tenant-approved SLA policy"/></label><label className="field"><span>Source document version</span><select required value={sourceVersionId} onChange={event => setSourceVersionId(event.target.value)}>{versions.map(version => <option key={version.id} value={version.id}>Version {version.version}{version.version === selectedDocument.version ? " · current" : ""}</option>)}</select></label><label className="field"><span>Effective from</span><input required type="datetime-local" value={slaFrom} onChange={event => setSlaFrom(event.target.value)}/></label><label className="field"><span>Effective to (optional)</span><input type="datetime-local" value={slaTo} onChange={event => setSlaTo(event.target.value)}/></label></div>
        <label className="field"><span>Validated SLA payload (JSON)</span><textarea required rows={10} value={slaPayload} onChange={event => setSlaPayload(event.target.value)} placeholder={'Use the policy contract values. Required fields: calendar or calendarByPriority, targetsByPriority, pausedStatuses, resolvedStatuses, riskAtPercent. Optional: teamIds.'}/></label>
        <button className="button button-primary" type="submit" disabled={!!busy || !slaPayload.trim() || !sourceVersionId}>{busy === "create-sla" ? <Activity size={14}/> : <Check size={14}/>} Create pending SLA version</button>
      </form>
      <div className="policy-version-list"><h4>Existing SLA policies and versions</h4>{policies.length ? policies.map(policy => <article className="candidate-rule" key={policy.id}><div className="policy-section-heading"><strong>{policy.description}</strong><small>{policy.status}</small></div>{policy.versions?.map(version => <div className="policy-version-row" key={version.id}><span>Version {version.version} · {version.status} · effective {version.effectiveFrom ?? "not set"}</span>{version.status === "pending_approval" && <div className="policy-review-actions"><label className="field"><span>Approval reason</span><input value={approvalReasons[version.id] ?? ""} onChange={event => setApprovalReasons(current => ({ ...current, [version.id]: event.target.value }))} placeholder="Required human approval reason"/></label><button className="button button-primary" disabled={!!busy || !(approvalReasons[version.id] ?? "").trim()} onClick={() => void act(`policy-approve-${version.id}`, async () => { await api.approveSlaPolicy(policy.id, version.id, approvalReasons[version.id]!.trim()); setMessage("SLA version approved. Activate it separately when ready."); await load(); })}>Approve</button></div>}{version.status === "approved" && <button className="button button-secondary" disabled={!!busy} onClick={() => void act(`policy-activate-${version.id}`, async () => { await api.activateSlaPolicy(policy.id, version.id); setMessage("SLA version activated and available to the SLA evaluator."); await load(); })}>Activate approved version</button>}</div>)}</article>) : <p className="muted-copy">No configured SLA policy versions.</p>}</div>
    </section>}
  </section>;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "The request failed."; }
