//! A map that keeps the order its keys first came in, as JavaScript's `Map` does, which the other
//! sides' walks follow: what a side does to each entry in turn goes in that order on every side.
//!
//! Its entries lie in the order they came, and a hash table finds each key's place among them, as
//! Python's compact `dict` lays them out: a lookup, an insert and a removal cost the same however
//! many keys it holds. A removal leaves a hole in its place, so the entries after it keep theirs;
//! the holes go once they outnumber the entries held, each place then found anew.

use std::collections::HashMap;
use std::hash::Hash;

#[cfg(test)]
mod tests;

/// A map that keeps the order its keys first came in.
#[derive(Debug, Clone)]
pub(crate) struct Ordered<K, V> {
    // the entries in the order they came, a hole where one was removed
    entries: Vec<Option<(K, V)>>,
    // each key held, and its place in `entries`
    places: HashMap<K, usize>,
}

impl<K, V> Default for Ordered<K, V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            places: HashMap::new(),
        }
    }
}

impl<K: Eq + Hash + Clone, V> Ordered<K, V> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn len(&self) -> usize {
        self.places.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.places.is_empty()
    }

    pub(crate) fn get(&self, key: &K) -> Option<&V> {
        let at = *self.places.get(key)?;

        self.entries
            .get(at)
            .and_then(Option::as_ref)
            .map(|(_, value)| value)
    }

    pub(crate) fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        let at = *self.places.get(key)?;

        self.entries
            .get_mut(at)
            .and_then(Option::as_mut)
            .map(|(_, value)| value)
    }

    pub(crate) fn contains_key(&self, key: &K) -> bool {
        self.places.contains_key(key)
    }

    /// Sets `key` to `value`: a key held keeps its place, a new one comes last.
    pub(crate) fn insert(&mut self, key: K, value: V) -> Option<V> {
        if let Some(held) = self.get_mut(&key) {
            return Some(core::mem::replace(held, value));
        }

        self.push(key, value);

        None
    }

    /// The value of `key`, made with `make` and set last when it is none.
    pub(crate) fn entry_or_insert_with<F: FnOnce() -> V>(
        &mut self,
        key: K,
        make: F,
    ) -> Option<&mut V> {
        let at = match self.places.get(&key) {
            Some(&at) => at,
            None => self.push(key, make()),
        };

        self.entries
            .get_mut(at)
            .and_then(Option::as_mut)
            .map(|(_, value)| value)
    }

    // a new key, set last; its place
    fn push(&mut self, key: K, value: V) -> usize {
        let at = self.entries.len();

        self.places.insert(key.clone(), at);
        self.entries.push(Some((key, value)));

        at
    }

    /// Removes `key`: the keys after it keep their order, and it comes last when set again.
    pub(crate) fn remove(&mut self, key: &K) -> Option<V> {
        let at = self.places.remove(key)?;
        let taken = self
            .entries
            .get_mut(at)
            .and_then(Option::take)
            .map(|(_, value)| value);

        self.compact();

        taken
    }

    // ! the holes go once they outnumber the entries held, so each removal costs a constant on
    // average and the entries never take more than twice the room of those held
    fn compact(&mut self) {
        let holes = self.entries.len().saturating_sub(self.places.len());

        if holes <= self.places.len() {
            return;
        }

        self.entries.retain(Option::is_some);

        for (at, entry) in self.entries.iter().enumerate() {
            if let Some((key, _)) = entry
                && let Some(place) = self.places.get_mut(key)
            {
                *place = at;
            }
        }
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries
            .iter()
            .filter_map(|entry| entry.as_ref().map(|(key, value)| (key, value)))
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &K> {
        self.iter().map(|(key, _)| key)
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &V> {
        self.iter().map(|(_, value)| value)
    }

    pub(crate) fn retain<F: FnMut(&K, &mut V) -> bool>(&mut self, mut keep: F) {
        let places = &mut self.places;

        for entry in &mut self.entries {
            let is_kept = entry.as_mut().is_none_or(|(key, value)| keep(key, value));

            if !is_kept && let Some((key, _)) = entry.take() {
                places.remove(&key);
            }
        }

        self.compact();
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.places.clear();
    }

    pub(crate) fn drain(&mut self) -> impl Iterator<Item = (K, V)> {
        self.places.clear();

        self.entries.drain(..).flatten()
    }
}
