//! A session's token: 16 bytes drawn from the system's source, never all zero, which the wire
//! carries as an `OPAQUE` credential and an application reads in unpadded base64url (spec 13.2).

use core::fmt;
use core::str::FromStr;

use crate::base64url;
use crate::constants::SESSION_TOKEN_BYTES;
use crate::errors::ProgrammerError;

#[cfg(test)]
mod tests;

/// A session's token: 16 bytes, not all zero, written in unpadded base64url.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionToken([u8; SESSION_TOKEN_BYTES]);

impl SessionToken {
    /// The token 16 bytes spell; a [`ProgrammerError`] for 16 zero bytes, which no token is.
    ///
    /// # Errors
    ///
    /// When every byte is zero.
    pub fn new(bytes: [u8; SESSION_TOKEN_BYTES]) -> Result<Self, ProgrammerError> {
        if bytes.iter().all(|&byte| byte == 0) {
            return Err(ProgrammerError::new(
                "a session token is 16 bytes, not all zero; got all zero",
            ));
        }

        Ok(Self(bytes))
    }

    /// The token `bytes` spell; a [`ProgrammerError`] for any other length, or for 16 zero bytes.
    ///
    /// # Errors
    ///
    /// When `bytes` are not 16, or every one is zero.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, ProgrammerError> {
        let held: [u8; SESSION_TOKEN_BYTES] = bytes.try_into().map_err(|_error| {
            ProgrammerError::new(format!(
                "a session token is 16 bytes, not all zero; got {}",
                bytes.len()
            ))
        })?;

        Self::new(held)
    }

    /// A token not `is_in_use`, from 16 bytes of the system's source; bytes that are all zero, or
    /// a token in use, are drawn again.
    ///
    /// # Errors
    ///
    /// When the system's source gives nothing.
    pub fn draw<F: Fn(&Self) -> bool>(is_in_use: F) -> Result<Self, getrandom::Error> {
        loop {
            let mut bytes = [0_u8; SESSION_TOKEN_BYTES];

            getrandom::fill(&mut bytes)?;

            if let Ok(token) = Self::new(bytes)
                && !is_in_use(&token)
            {
                return Ok(token);
            }
        }
    }

    /// Its bytes.
    #[must_use]
    pub fn bytes(&self) -> &[u8; SESSION_TOKEN_BYTES] {
        &self.0
    }

    /// Whether `presented` is this token, compared in constant time (spec 9.2, step 6): every byte
    /// is read, wherever the two differ.
    #[must_use]
    pub fn is(&self, presented: &Self) -> bool {
        self.0
            .iter()
            .zip(presented.0.iter())
            .fold(0_u8, |difference, (held, given)| {
                difference | (held ^ given)
            })
            == 0
    }
}

impl fmt::Display for SessionToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&base64url::encode(&self.0))
    }
}

impl fmt::Debug for SessionToken {
    // ! none of its bytes: a bearer's token, which no string a side writes carries (spec 15.1), an
    // application's derived Debug of what holds it included; Display alone spells it (spec 13.2)
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionToken(…)")
    }
}

impl FromStr for SessionToken {
    type Err = ProgrammerError;

    /// The token `text` spells: 16 bytes in unpadded base64url, 22 characters, not all zero.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let refused = || ProgrammerError::new(format!("{text:?} is not a session token"));

        if text.len() != 22 {
            return Err(refused());
        }

        let bytes = base64url::decode(text.as_bytes()).ok_or_else(refused)?;

        Self::from_slice(&bytes).map_err(|_error| refused())
    }
}
