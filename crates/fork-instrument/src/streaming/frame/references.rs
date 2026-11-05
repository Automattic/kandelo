use super::{FrameLayout, LocalKey};
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{RefType, ValType};

#[derive(Clone, Copy, Debug)]
pub struct FrameReferenceSlot {
    pub local: LocalKey,
    pub ty: RefType,
    pub universal_position: Option<u32>,
}
#[derive(Debug)]
pub struct FrameReferencePlan {
    pub slots: Vec<FrameReferenceSlot>,
    pub slots_by_call: Vec<Vec<usize>>,
    pub null_locals_by_call: Vec<Vec<(LocalKey, RefType)>>,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct FrameCodecShape {
    pub scalars: Vec<ValType>,
    pub catch_selector: bool,
    pub commits: bool,
    pub restored_scalars: usize,
}

impl FrameLayout {
    /// Input sets already include callee/carryover/ancestor values and every
    /// reference parameter needed by the zero-argument resume thunk.
    pub fn reference_plan(
        &self,
        per_call: &[Vec<LocalKey>],
        nulls: &[Vec<LocalKey>],
    ) -> Result<FrameReferencePlan> {
        ensure!(
            per_call.len() == nulls.len(),
            "reference/null landing count mismatch"
        );
        let memberships = per_call
            .iter()
            .chain(nulls)
            .try_fold(0usize, |n, v| n.checked_add(v.len()))
            .context("frame reference membership overflow")?;
        ensure!(
            memberships <= self.limits.reference_memberships,
            "frame references exceed membership budget"
        );
        let estimate = memberships
            .checked_mul(256)
            .and_then(|n| n.checked_add(per_call.len().checked_mul(128)?))
            .context("frame reference metadata overflow")?;
        ensure!(
            estimate <= self.limits.metadata_bytes,
            "frame references exceed metadata budget"
        );
        let reference = |key| -> Result<RefType> {
            match self.local(key)?.ty {
                ValType::Ref(ty) => Ok(ty),
                _ => anyhow::bail!("scalar in frame reference plan"),
            }
        };
        let mut sets = Vec::with_capacity(per_call.len());
        let mut counts = BTreeMap::<LocalKey, usize>::new();
        let mut null_locals_by_call = Vec::with_capacity(per_call.len());
        for (values, nulls) in per_call.iter().zip(nulls) {
            let mut set = BTreeSet::new();
            for &key in values {
                reference(key)?;
                set.insert(key);
            }
            for &key in &set {
                *counts.entry(key).or_default() += 1;
            }
            sets.push(set);
            let mut unique = BTreeMap::new();
            for &key in nulls {
                let ty = reference(key)?;
                ensure!(
                    ty.nullable,
                    "definitely-null restoration requires a nullable local"
                );
                unique.insert(key, ty);
            }
            null_locals_by_call.push(unique.into_iter().collect());
        }
        let mut ordered: Vec<_> = counts.keys().copied().collect();
        ordered.sort_by_key(|key| (counts[key] != per_call.len(), *key));
        let mut positions = BTreeMap::new();
        let mut slots = Vec::with_capacity(ordered.len());
        for (i, key) in ordered.into_iter().enumerate() {
            positions.insert(key, i);
            slots.push(FrameReferenceSlot {
                local: key,
                ty: reference(key)?,
                universal_position: (counts[&key] == per_call.len()).then_some(u32::try_from(i)?),
            });
        }
        let slots_by_call = sets
            .into_iter()
            .map(|set| {
                let mut slots: Vec<_> = set.into_iter().map(|key| positions[&key]).collect();
                slots.sort_unstable();
                slots
            })
            .collect();
        Ok(FrameReferencePlan {
            slots,
            slots_by_call,
            null_locals_by_call,
        })
    }
    /// Shared restore helpers return at most one value, counting the catch
    /// selector, to preserve the baseline engine's recursion frame budget.
    pub fn codec_shape(
        &self,
        catch_selector: bool,
        references: &FrameReferencePlan,
    ) -> Option<FrameCodecShape> {
        let scalars: Vec<_> = self
            .fields
            .iter()
            .filter(|f| {
                !self
                    .scratch
                    .as_ref()
                    .is_some_and(|s| s.offsets.contains_key(&f.local))
            })
            .map(|f| f.ty)
            .collect();
        if scalars.len() > 900 {
            return None;
        }
        Some(FrameCodecShape {
            restored_scalars: usize::from(!catch_selector).min(scalars.len()),
            scalars,
            catch_selector,
            commits: self.scratch.is_none()
                && !catch_selector
                && references.slots_by_call.iter().all(Vec::is_empty),
        })
    }
}
