export type Approval =
  | { kind: "approve"; id: number | null }
  | { kind: "reject"; id: number | null }
  | { kind: "edit"; id: number; text: string };

const APPROVE = /^(ok|okay|okey|sim|pode|aprovo|aprovado|aprova|manda|envia|pode mandar|pode enviar|✅|👍)\s*(?:a\s+|o\s+)?#?(\d+)?\s*[.!]*$/i;
const REJECT = /^(n[ãa]o|nao|nega|negado|cancela|cancelar|rejeita|rejeitado|não manda|nao manda|❌|👎)\s*(?:a\s+|o\s+)?#?(\d+)?\s*[.!]*$/i;
const EDIT = /^#?(\d+)\s*[:\-–]\s*([\s\S]+)$/;

/** Reconhece respostas curtas de aprovação no chat do dono. Retorna null se não for uma. */
export function parseApproval(text: string): Approval | null {
  const t = text.trim();
  if (!t) return null;
  let m = APPROVE.exec(t);
  if (m) return { kind: "approve", id: m[2] ? Number(m[2]) : null };
  m = REJECT.exec(t);
  if (m) return { kind: "reject", id: m[2] ? Number(m[2]) : null };
  m = EDIT.exec(t);
  if (m) return { kind: "edit", id: Number(m[1]), text: m[2].trim() };
  return null;
}
