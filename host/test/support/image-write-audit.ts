// The graphics gate runs with the image write-count audit on: a write path
// that changes a CPU-tier mirror's pixels without advancing its storage's
// write count fails loudly instead of leaving its pixels unpublished.
import { setImageWriteAudit } from "../../src/webgl/image-writes.js";

setImageWriteAudit(true);
