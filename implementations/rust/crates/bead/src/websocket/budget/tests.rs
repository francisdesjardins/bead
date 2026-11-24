use super::*;
use crate::testing::SteppingClock;

const GRACE: Duration = Duration::from_secs(5);

fn budget_of(clock: &Arc<SteppingClock>, budget: u64) -> Arc<MessageBudget> {
    MessageBudget::new(MessageBounds {
        message_bytes_budget: budget,
        minimum_body_bytes_per_second: 240,
        body_grace_period: GRACE,
        clock: Arc::<SteppingClock>::clone(clock),
    })
}

fn clock() -> Arc<SteppingClock> {
    SteppingClock::new(std::time::SystemTime::UNIX_EPOCH)
}

// a holding whose message began and was charged `bytes`
fn holding_of(budget: &Arc<MessageBudget>, bytes: u64) -> Holding {
    let mut holding = budget.holding();

    holding.begin();
    assert!(holding.charge(bytes), "{bytes} charged");

    holding
}

// spec 15.12.19
#[tokio::test]
async fn casts_off_with_1013_the_connections_whose_messages_hold_the_most_when_a_charge_would_pass_message_bytes_budget_its_own_only_when_it_comes_first()
 {
    let clock = clock();
    let budget = budget_of(&clock, 500);
    let ada = holding_of(&budget, 194);
    let bob = holding_of(&budget, 146);
    let mut carol = budget.holding();

    carol.begin();

    assert!(carol.charge(174), "carol's charge taken, ada cast off");
    assert!(ada.is_cast_off(), "ada, who held the most");
    assert!(!bob.is_cast_off(), "bob kept");
    assert_eq!(budget.held(), 320, "ada's charge released");

    let mut dave = budget.holding();

    dave.begin();

    assert!(dave.charge(134), "dave's head fits");
    assert!(!dave.charge(47), "dave, who would hold the most, cast off");
    assert!(dave.is_cast_off(), "dave cast off");
    assert_eq!(budget.held(), 320, "dave's charge released");
    assert!(!dave.charge(1), "nothing charged after");

    carol.end();
    assert_eq!(budget.held(), 146, "carol's whole: released");
}

// spec 15.12.19
#[tokio::test]
async fn charges_byte_by_byte_casting_off_whom_the_unit_that_passes_the_budget_finds_first() {
    let clock = clock();

    // * one charge of 650, or 450 then 200: the unit past 1,000 finds x first, 600 against a's 401
    for cuts in [vec![650], vec![450, 200]] {
        let budget = budget_of(&clock, 1_000);
        let x = holding_of(&budget, 600);
        let mut a = budget.holding();

        a.begin();

        for cut in &cuts {
            assert!(a.charge(*cut), "{cuts:?}: a's {cut} taken");
        }

        assert!(x.is_cast_off(), "{cuts:?}: x, who held the most then");
        assert!(!a.is_cast_off(), "{cuts:?}: a kept");
        assert_eq!(budget.held(), 650, "{cuts:?}: a's 650 held");
    }
}

// spec 15.12.19
#[tokio::test]
async fn casts_off_each_holder_that_comes_before_a_message_whose_charge_alone_passes_the_budget_then_that_message_s_connection()
 {
    let clock = clock();

    for held in [1_096, 1_800] {
        let budget = budget_of(&clock, 2_000);
        let p = holding_of(&budget, held);
        let mut a = budget.holding();

        a.begin();

        assert!(
            !a.charge(2_036),
            "p {held}: a, past the budget alone, cast off"
        );
        assert!(p.is_cast_off(), "p {held}: p, who came before a");
        assert!(a.is_cast_off(), "p {held}: a cast off");
        assert_eq!(budget.held(), 0, "p {held}: every charge released");
    }
}

// spec 15.12.19
#[tokio::test]
async fn casts_off_among_equal_sums_the_holder_whose_message_began_first() {
    let clock = clock();
    let budget = budget_of(&clock, 100);
    let first = holding_of(&budget, 40);
    let second = holding_of(&budget, 40);
    let mut third = budget.holding();

    third.begin();

    assert!(third.charge(30), "the third's charge taken");
    assert!(first.is_cast_off(), "the first begun");
    assert!(!second.is_cast_off(), "the second kept");
    assert_eq!(budget.held(), 70, "the first's charge released");
}

#[tokio::test]
async fn counts_a_message_s_time_only_while_its_connection_is_not_paused() {
    let clock = clock();
    let budget = budget_of(&clock, 1_000);
    let holding = holding_of(&budget, 10);
    let partway = holding.partway();

    clock.advance(Duration::from_secs(1)).await;
    partway.pause();
    clock.advance(Duration::from_secs(9)).await;

    assert_eq!(partway.elapsed(), Some(Duration::from_secs(1)), "paused");

    partway.resume();
    clock.advance(Duration::from_secs(2)).await;

    assert_eq!(
        partway.elapsed(),
        Some(Duration::from_secs(3)),
        "counted again"
    );
}
