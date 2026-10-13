import rawCounselling from "@/counselling.json";
import rawProtocol from "@/imnci-sick-child-2m-5y.json";
import { validateCounselling, type CounsellingFile } from "@/lib/imnci/counselling";
import type { ImnciProtocol } from "@/lib/imnci/rules";

export const COUNSELLING = rawCounselling as unknown as CounsellingFile;

// Fail at load, not in front of a mother, if an entry is marked verified without a page, quote
// and date, or names a classification the protocol does not have (for example a retired one).
validateCounselling(COUNSELLING, rawProtocol as unknown as ImnciProtocol);
