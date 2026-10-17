export interface VcardContact {
  name: string;
  phone: string | null; // só dígitos
}

/** Extrai nome e telefone (preferindo o waid do WhatsApp) de um vCard. */
export function parseVcard(vcard: string): VcardContact | null {
  const lines = vcard.replace(/\r/g, "").split("\n");
  let name = "";
  let phone: string | null = null;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("FN:")) name = line.slice(3).trim();
    else if (!name && upper.startsWith("N:")) name = line.slice(2).split(";").filter(Boolean).reverse().join(" ").trim();
    else if (upper.startsWith("TEL")) {
      const waid = /waid=(\d+)/i.exec(line);
      const digits = waid ? waid[1] : (line.split(":").pop() ?? "").replace(/\D/g, "");
      if (digits.length >= 8 && !phone) phone = digits;
    }
  }
  if (!name && !phone) return null;
  return { name: name || "Contato", phone };
}
