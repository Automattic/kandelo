use super::*;

pub(super) struct TransactionReader {
    bytes: IoBuffer<u8>,
    pages: IoBuffer<[u8; 32]>,
    record: IoBuffer<u8>,
    cached_page: Option<usize>,
    start: u64,
    length: usize,
    consumed: usize,
    body_end: usize,
    transaction_limit: usize,
}

impl TransactionReader {
    #[cfg(test)]
    pub(super) fn new() -> Self { Self::with_limit(MAX_TRANSACTION_BYTES) }

    pub(super) fn with_limit(transaction_limit: usize) -> Self {
        Self {
            bytes: IoBuffer::new(),
            pages: IoBuffer::new(),
            record: IoBuffer::new(),
            cached_page: None,
            start: 0,
            length: 0,
            consumed: 0,
            body_end: 0,
            transaction_limit,
        }
    }

    pub(super) fn exhausted(&self) -> bool { self.consumed == self.body_end }

    pub(super) fn load<S: OverlayStorage>(
        &mut self,
        storage: &mut S,
        start: u64,
        header: &[u8; TRANSACTION_HEADER_BYTES],
        sequence: u64,
        mut validate: impl FnMut(DecodedMutation<'_>) -> Result<(), Errno>,
    ) -> Result<(), Errno> {
        let length = u32::from_le_bytes(header[4..8].try_into().map_err(|_| Errno::EIO)?) as usize;
        if &header[..4] != TRANSACTION_MAGIC
            || self.transaction_limit > MAX_TRANSACTION_BYTES
            || !(TRANSACTION_HEADER_BYTES + TRANSACTION_TRAILER_BYTES..=self.transaction_limit).contains(&length)
            || u32::from_le_bytes(header[20..24].try_into().map_err(|_| Errno::EIO)?) != !(length as u32)
            || u64::from_le_bytes(header[8..16].try_into().map_err(|_| Errno::EIO)?) != sequence
        {
            return Err(Errno::EIO);
        }
        start.checked_add(length as u64).ok_or(Errno::EOVERFLOW)?;
        self.start = start;
        self.length = length;
        self.consumed = 0;
        self.body_end = length - TRANSACTION_TRAILER_BYTES - TRANSACTION_HEADER_BYTES;
        self.cached_page = None;
        self.pages.clear();
        let capacity = length.min(TRANSACTION_WRITE_BYTES);
        self.bytes.reserve_with(capacity, |bytes| reserve_transaction_bytes(bytes, capacity))?;
        if length <= TRANSACTION_WRITE_BYTES {
            self.bytes.resize(length, 0);
            storage.read_exact_at(start, &mut self.bytes)?;
            let digest_start = length - TRANSACTION_TRAILER_BYTES;
            if &self.bytes[..TRANSACTION_HEADER_BYTES] != header
                || &self.bytes[length - 4..] != COMMIT_MAGIC
                || self.bytes[digest_start..length - 4] != Sha256::digest(&self.bytes[..digest_start])[..]
            {
                return Err(Errno::EIO);
            }
            let records = decode_mutations(&self.bytes[TRANSACTION_HEADER_BYTES..digest_start])?;
            if records.len() != u32::from_le_bytes(header[16..20].try_into().map_err(|_| Errno::EIO)?) as usize {
                return Err(Errno::EIO);
            }
            for record in records { validate(record)?; }
            return Ok(());
        }
        let page_count = length.div_ceil(TRANSACTION_WRITE_BYTES);
        self.pages.try_reserve_exact(page_count)?;
        let digest_start = length - TRANSACTION_TRAILER_BYTES;
        let mut digest = Sha256::new();
        let mut trailer = [0; TRANSACTION_TRAILER_BYTES];
        for page in 0..page_count {
            let offset = page * TRANSACTION_WRITE_BYTES;
            let count = (length - offset).min(TRANSACTION_WRITE_BYTES);
            self.bytes.resize(count, 0);
            storage.read_exact_at(start + offset as u64, &mut self.bytes)?;
            if page == 0 && &self.bytes[..TRANSACTION_HEADER_BYTES] != header { return Err(Errno::EIO); }
            digest.update(&self.bytes[..digest_start.saturating_sub(offset).min(count)]);
            let trailer_start = digest_start.max(offset);
            if trailer_start < offset + count {
                trailer[trailer_start - digest_start..offset + count - digest_start]
                    .copy_from_slice(&self.bytes[trailer_start - offset..]);
            }
            self.pages.push(Sha256::digest(&self.bytes).into());
            self.cached_page = Some(page);
        }
        if &trailer[32..] != COMMIT_MAGIC || trailer[..32] != digest.finalize()[..] { return Err(Errno::EIO); }
        let mut count = 0usize;
        while let Some(record) = self.next_record(storage)? {
            validate(record)?;
            count = count.checked_add(1).ok_or(Errno::EIO)?;
        }
        if count != u32::from_le_bytes(header[16..20].try_into().map_err(|_| Errno::EIO)?) as usize {
            return Err(Errno::EIO);
        }
        self.consumed = 0;
        Ok(())
    }

    fn read_range<S: OverlayStorage>(&mut self, storage: &mut S, mut offset: usize, mut output: &mut [u8]) -> Result<(), Errno> {
        if offset.checked_add(output.len()).ok_or(Errno::EIO)? > self.length { return Err(Errno::EIO); }
        while !output.is_empty() {
            let page = offset / TRANSACTION_WRITE_BYTES;
            let start = page * TRANSACTION_WRITE_BYTES;
            if self.cached_page != Some(page) {
                let count = (self.length - start).min(TRANSACTION_WRITE_BYTES);
                self.cached_page = None;
                self.bytes.resize(count, 0);
                storage.read_exact_at(self.start + start as u64, &mut self.bytes)?;
                if Sha256::digest(&self.bytes)[..] != self.pages.get(page).ok_or(Errno::EIO)?[..] { return Err(Errno::EIO); }
                self.cached_page = Some(page);
            }
            let within = offset - start;
            let count = output.len().min(self.bytes.len() - within);
            output[..count].copy_from_slice(&self.bytes[within..within + count]);
            output = &mut output[count..];
            offset += count;
        }
        Ok(())
    }

    pub(super) fn next_record<S: OverlayStorage>(&mut self, storage: &mut S) -> Result<Option<DecodedMutation<'_>>, Errno> {
        if self.consumed == self.body_end { return Ok(None); }
        if self.consumed > self.body_end { return Err(Errno::EIO); }
        if self.length <= TRANSACTION_WRITE_BYTES {
            let (record, next) = decode_mutation(
                &self.bytes[TRANSACTION_HEADER_BYTES + self.consumed..TRANSACTION_HEADER_BYTES + self.body_end], self.consumed)?;
            self.consumed = next;
            return Ok(Some(record));
        }
        let available = self.body_end - self.consumed;
        if available < 23 { return Err(Errno::EIO); }
        let offset = TRANSACTION_HEADER_BYTES + self.consumed;
        let mut header = [0; 23 + 255];
        self.read_range(storage, offset, &mut header[..19])?;
        let header_length = 23 + header[18] as usize;
        if header_length > available { return Err(Errno::EIO); }
        self.read_range(storage, offset + 19, &mut header[19..header_length])?;
        let value_length = u32::from_le_bytes(header[header_length - 4..header_length].try_into().map_err(|_| Errno::EIO)?) as usize;
        if value_length > MAX_INODE_RECORD_BYTES { return Err(Errno::EIO); }
        let record_length = header_length.checked_add(value_length).ok_or(Errno::EIO)?;
        if record_length > available { return Err(Errno::EIO); }
        self.record.reserve_with(record_length, |bytes| reserve_transaction_bytes(bytes, record_length))?;
        self.record.resize(record_length, 0);
        self.record[..header_length].copy_from_slice(&header[..header_length]);
        let mut bytes = core::mem::take(&mut self.record);
        let result = self.read_range(storage, offset + header_length, &mut bytes[header_length..]);
        self.record = bytes;
        result?;
        let (record, next) = decode_mutation(&self.record, self.consumed)?;
        self.consumed = next;
        Ok(Some(record))
    }

    pub(super) fn append_digest<S: OverlayStorage>(&mut self, storage: &mut S, digest: &mut Sha256) -> Result<(), Errno> {
        if self.length <= TRANSACTION_WRITE_BYTES {
            digest.update(&self.bytes);
            return Ok(());
        }
        for page in 0..self.pages.len() {
            let mut probe = [0; 1];
            self.read_range(storage, page * TRANSACTION_WRITE_BYTES, &mut probe)?;
            digest.update(&self.bytes);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn retained_bytes(&self) -> usize {
        self.bytes.capacity() + self.pages.capacity() * 32 + self.record.capacity()
    }
}
