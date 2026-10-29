//! A map that keeps the order its keys first came in, as JavaScript's `Map` does, which the other
//! sides' walks follow: what a side does to each entry in turn goes in that order on every side.

/// A map that keeps the order its keys first came in.
#[derive(Debug, Clone)]
pub(crate) struct Ordered<K, V> {
    entries: Vec<(K, V)>,
}

impl<K, V> Default for Ordered<K, V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<K: PartialEq, V> Ordered<K, V> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn get(&self, key: &K) -> Option<&V> {
        self.entries
            .iter()
            .find(|(held, _)| held == key)
            .map(|(_, value)| value)
    }

    pub(crate) fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.entries
            .iter_mut()
            .find(|(held, _)| held == key)
            .map(|(_, value)| value)
    }

    pub(crate) fn contains_key(&self, key: &K) -> bool {
        self.get(key).is_some()
    }

    /// Sets `key` to `value`: a key held keeps its place, a new one comes last.
    pub(crate) fn insert(&mut self, key: K, value: V) -> Option<V> {
        if let Some(held) = self.get_mut(&key) {
            return Some(core::mem::replace(held, value));
        }

        self.entries.push((key, value));

        None
    }

    /// The value of `key`, made with `make` and set last when it is none.
    pub(crate) fn entry_or_insert_with<F: FnOnce() -> V>(
        &mut self,
        key: K,
        make: F,
    ) -> Option<&mut V> {
        let at = if let Some(at) = self.entries.iter().position(|(held, _)| *held == key) {
            at
        } else {
            self.entries.push((key, make()));
            self.entries.len().saturating_sub(1)
        };

        self.entries.get_mut(at).map(|(_, value)| value)
    }

    pub(crate) fn remove(&mut self, key: &K) -> Option<V> {
        let at = self.entries.iter().position(|(held, _)| held == key)?;

        Some(self.entries.remove(at).1)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &K> {
        self.entries.iter().map(|(key, _)| key)
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub(crate) fn retain<F: FnMut(&K, &mut V) -> bool>(&mut self, mut keep: F) {
        self.entries.retain_mut(|(key, value)| keep(key, value));
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    pub(crate) fn drain(&mut self) -> impl Iterator<Item = (K, V)> {
        self.entries.drain(..)
    }
}
