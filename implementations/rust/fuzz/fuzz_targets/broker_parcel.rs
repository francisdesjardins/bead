//! `broker-parcel`: raw bytes, as a broker delivers a message, read by the parcel reader (spec
//! 15.17), which gives a parcel, no parcel or a parcel that does not read, and never panics. A
//! parcel that reads is written again: its writer refuses exactly those it refuses by design, a
//! layout other than `0xB1`, an advisory kind or one not assigned, an OPEN or an ACCEPT that names
//! no token or a receive bound out of range (15.18), and never with its read-back refusal; what it
//! writes reads as the same parcel and writes again to the same bytes. The TypeScript side's
//! `tools/fuzz/broker-parcel.ts` and the C# side's `BrokerParcelTarget` are its twins.

#![no_main]

use bead::testing::parcels::{ParcelReading, is_refused_by_design, read, write};
use libfuzzer_sys::fuzz_target;

// the writer's own refusal of what would not read back: never met by a parcel that read
const READ_BACK: &str = "a parcel this side refuses is never written";

fuzz_target!(|data: &[u8]| {
    let ParcelReading::Parcel(fields) = read(data) else {
        return;
    };

    match write(&fields) {
        Err(refused) => {
            assert!(
                !refused.starts_with(READ_BACK),
                "refused on reading back, {refused}: {fields:?}"
            );
            assert!(
                is_refused_by_design(&fields),
                "refused, not by design, {refused}: {fields:?}"
            );
        }
        Ok(bytes) => {
            assert!(
                !is_refused_by_design(&fields),
                "written, where it is refused by design: {fields:?}"
            );

            let again = read(&bytes);

            assert!(
                matches!(&again, ParcelReading::Parcel(again) if *again == fields),
                "what it wrote reads as {again:?}: {fields:?}"
            );
            assert!(
                matches!(write(&fields), Ok(twice) if twice == bytes),
                "written again to the same bytes: {fields:?}"
            );
        }
    }
});
