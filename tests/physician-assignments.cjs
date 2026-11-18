// Run with node tests/physician-assignments.cjs after installing Playwright and Chromium.
const { chromium } = require('playwright');
const { strict: assert } = require('node:assert');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ timezoneId: 'America/Toronto' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-11-18T16:00:00Z') });
    await page.addInitScript(() => {
      const mine = { PHYSICIAN_ID: '564826', NURSE_PRSNL_ID: 6227469, NURSE_NAME: 'Same Name' };
      const other = { PHYSICIAN_ID: 1253867, NURSE_PRSNL_ID: 2, NURSE_NAME: 'Same Name' };
      const appointments = [
        { id: 1, physician: 564826, patient: 'Own Patient', note: 'Saved first line\nSaved second line' },
        { id: 2, physician: '1253867', patient: 'Other Patient', note: 'Other note' },
        { id: 3, physician: 564826, patient: 'Without Comment', note: '' }
      ];
      window.mock = { assignments: [mine, other], calls: [], printed: '', printCount: 0 };
      window.print = () => {
        mock.printCount++;
        mock.printed = document.getElementById('printArea').innerHTML;
      };
      localStorage.setItem('nygh_onc_charge_physicians_v1_6227469', '[1253867]');
      window.XMLCclRequest = class {
        open(method, program, async) { this.program = program.split(':')[0]; }
        send(args) {
          const m = window.mock;
          m.calls.push([this.program, args]);
          const finish = (data, status = 200) => {
            this.readyState = 4;
            this.status = status;
            this.responseText = JSON.stringify({ REPLY: data });
            this.onreadystatechange();
          };
          queueMicrotask(() => {
            switch (this.program) {
              case 'mrd_onc_charge_nurse_access':
                return finish({ USER_ID: '6227469', USER_NAME: 'Same Name', CAN_EDIT: 1 });
              case 'mrd_onc_charge_assign_get':
                if (m.timeoutGet) return;
                if (m.failGet) return finish({}, 503);
                if (m.holdGet) {
                  m.finishGet = () => finish({ QUAL: m.assignments.length, ASSIGNMENTS: m.assignments });
                  return;
                }
                return finish({ QUAL: m.qual ?? m.assignments.length, ASSIGNMENTS: m.assignments });
              case 'mrd_onc_charge_assign_save':
                m.completeSave = () => {
                  const [, id, action] = args.split(',');
                  if (m.failSave) {
                    m.assignments.push({ PHYSICIAN_ID: id, NURSE_PRSNL_ID: 3, NURSE_NAME: 'New Owner' });
                    return finish({ SUCCESS: 0, MESSAGE: 'Claimed by another nurse' });
                  }
                  if (action === '^ASSIGN^') m.assignments.push({ ...mine, PHYSICIAN_ID: id });
                  else m.assignments = m.assignments.filter(a => String(a.PHYSICIAN_ID) !== id);
                  return finish({ SUCCESS: 1 });
                };
                return;
              case 'mrd_onc_charge_nurse_mpage':
                return finish({ LIST: appointments.map(a => ({
                  pt_name: a.patient + (args.includes('19-NOV-2026') ? ' on next date' : ''),
                  attending: 'Same Doctor Name', attending_person_id: a.physician,
                  sched_event_id: a.id, person_id: a.id, encntr_id: a.id,
                  mrn: 'MRN' + a.id, pplan_name: 'Treatment Plan', resource: 'Chair ' + a.id,
                  appt_dttm: '2026-NOV-18 09:00', appt_status: 'Confirmed', dot: 'Day 1'
                })) });
              case 'mrd_onc_nurse_notes_get':
                return finish({ NOTES: appointments.map(a => ({
                  SCH_EVENT_ID: a.id, PERSON_ID: a.id, ENCNTR_ID: a.id, NURSE_NOTE: a.note
                })) });
              case 'mrd_onc_nurse_notes_save':
                return finish({ SUCCESS: 1, SCH_EVENT_ID: Number(args.split(',')[1]) });
              default: return finish({});
            }
          });
        }
      };
    });
    await page.route("http://localhost:8765/**", route => route.fulfill({ path: path.join(__dirname, '..', new URL(route.request().url()).pathname) }));
    await page.goto("http://localhost:8765/index.html");
    const at = selector => page.locator(selector);
    const check = id => at('[data-physician-id="' + id + '"]');
    const saves = () => page.evaluate(() => mock.calls.filter(([name]) => name === 'mrd_onc_charge_assign_save').map(([, args]) => args));
    const wait = async (selector, value) => {
      await page.waitForFunction(([selector, value]) => document.querySelector(selector).textContent.includes(value), [selector, value]);
    };
    await wait('#appointmentCount', '2');
    assert.match(await at('#appointmentGroups').innerText(), /Own Patient/);
    await at('#physicianDropdownButton').click();
    assert(await check(564826).isChecked());
    assert(await check(1253867).isDisabled());
    assert.match(await at('#physicianCheckboxList').innerText(), /Assigned · SN/);
    await check(1883690).click();
    await page.waitForFunction(() => !!mock.completeSave);
    assert(await check(4316564).isDisabled());
    await check(1883690).dispatchEvent('change');
    assert.deepEqual(await saves(), ['^MINE^,1883690,^ASSIGN^']);
    await page.evaluate(() => mock.completeSave());
    await wait('#physicianDropdownButton', '2 of 9');
    assert(await check(1883690).isChecked());
    await check(1883690).click();
    await page.waitForFunction(() => mock.calls.some(([, args]) => args === '^MINE^,1883690,^RELEASE^'));
    await page.evaluate(() => mock.completeSave());
    await wait('#physicianDropdownButton', '1 of 9');
    assert(!(await check(1883690).isChecked()));
    await page.evaluate(() => { mock.failSave = true; });
    await check(4316564).click();
    await page.waitForFunction(() => mock.calls.some(([, args]) => args === '^MINE^,4316564,^ASSIGN^'));
    await page.evaluate(() => mock.completeSave());
    await wait('#physicianAssignmentStatus', 'Claimed by another nurse');
    await wait('#physicianCheckboxList', 'Assigned · NO');
    assert(await check(4316564).isDisabled());
    assert(!(await check(4316564).isChecked()));

    assert.equal(await at('#nurseCommentsReportButton, #nurseCommentsReportDialog').count(), 0);
    const printArea = at('#printArea');
    await at('#printOptionsButton').click();
    assert.equal(await at('input[name="printLayout"]').count(), 5);
    assert.equal(await at('input[name="printLayout"]').first().getAttribute('value'), 'comments');
    assert(await at('input[value="comments"]').isChecked());
    assert.equal(await at('#printAttending').inputValue(), 'current');
    for (const id of ['printOnlyWithComments', 'printNotes']) assert(await at('#' + id).isChecked());
    for (const id of ['printHighlights', 'printStatuses']) assert(!(await at('#' + id).isChecked()));

    const printCount = () => page.evaluate(() => mock.printCount);
    const assignmentGets = () => page.evaluate(() => mock.calls.filter(([name]) => name === 'mrd_onc_charge_assign_get').length);
    const callsBeforePrint = await assignmentGets();
    await page.evaluate(() => { mock.holdGet = true; });
    await at('#previewPrint').click();
    await wait('#printAssignmentStatus', 'Refreshing physician assignments');
    assert(!(await printArea.isVisible()));
    assert(await at('#doPrint').isDisabled());
    await at('#doPrint').dispatchEvent('click');
    assert.equal(await assignmentGets(), callsBeforePrint + 1);
    await page.evaluate(() => { mock.holdGet = false; mock.finishGet(); });
    await printArea.waitFor({ state: 'visible' });
    assert.deepEqual(await printArea.locator('thead th').allTextContents(),
      ['Time', 'Patient', 'MRN', 'Regimen / Plan', 'Resource', 'Nurse comments']);
    assert.match(await printArea.innerText(), /Own Patient/);
    assert.doesNotMatch(await printArea.innerText(), /Without Comment|Other Patient/);
    assert.match(await printArea.innerText(), /Treatment Plan/);
    assert.match(await printArea.innerText(), /Chair 1/);
    assert.match(await printArea.textContent(), /Saved first line\nSaved second line/);
    await page.emulateMedia({ media: 'print' });
    assert(await printArea.isVisible());
    assert(!(await at('#printFromPreview').isVisible()));
    assert.equal(await printArea.locator('thead').evaluate(el => getComputedStyle(el).display), 'table-header-group');
    const pdf = await page.pdf({ preferCSSPageSize: true });
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => {
      mock.initialAssignments = mock.assignments;
      mock.assignments = [{ PHYSICIAN_ID: 1253867, NURSE_PRSNL_ID: '6227469' }];
    });
    await at('#printFromPreview').click();
    await page.waitForFunction(() => mock.printCount === 1);
    const updatedPrint = await page.evaluate(() => mock.printed);
    assert.match(updatedPrint, /Other Patient/);
    assert.doesNotMatch(updatedPrint, /Own Patient/);
    assert.match(await printArea.innerText(), /Other Patient/);
    assert.equal(await assignmentGets(), callsBeforePrint + 2);

    await page.evaluate(() => { mock.failGet = true; });
    await at('#printFromPreview').click();
    await wait('#printArea .print-assignment-status', 'CCL request status 503');
    assert.equal(await printCount(), 1);
    assert.equal(await printArea.locator('.print-sheet').count(), 0);
    await at('#closePrintPreview').click();

    await at('#printOptionsButton').click();
    await at('#previewPrint').click();
    await wait('#printAssignmentStatus', 'CCL request status 503');
    assert(!(await printArea.isVisible()));
    await page.evaluate(() => { mock.failGet = false; mock.qual = 2; });
    await at('#doPrint').click();
    await wait('#printAssignmentStatus', 'Unexpected physician assignment response');
    assert.equal(await printCount(), 1);
    await page.evaluate(() => { delete mock.qual; mock.timeoutGet = true; });
    await at('#doPrint').click();
    await wait('#printAssignmentStatus', 'Refreshing physician assignments');
    await page.clock.fastForward(30001);
    await wait('#printAssignmentStatus', 'timed out');
    assert.equal(await printCount(), 1);
    assert(await at('#printDialog').isVisible());

    await page.evaluate(() => {
      mock.timeoutGet = false;
      mock.assignments = mock.initialAssignments;
    });
    await at('#doPrint').click();
    await page.waitForFunction(() => mock.printCount === 2);
    assert.match(await page.evaluate(() => mock.printed), /Own Patient/);
    assert.doesNotMatch(await page.evaluate(() => mock.printed), /Other Patient/);

    const explicitGets = await assignmentGets();
    for (const layout of ['comments', 'simple', 'detailed', 'attending', 'worksheet']) {
      await at('#printOptionsButton').click();
      await at('input[name="printLayout"][value="' + layout + '"]').check();
      await at('#printAttending').selectOption('all');
      await at('#previewPrint').click();
      assert.match(await printArea.innerText(), /Own Patient/);
      assert.match(await printArea.innerText(), /Other Patient/);
      if (layout === 'comments') assert.equal(await printArea.locator('.print-attending-heading').count(), 2);
      if (layout === 'detailed') assert.match(await printArea.innerText(), /Appointment type/);
      if (layout === 'worksheet') assert.match(await printArea.innerText(), /Handwritten notes/);
      await at('#printFromPreview').click();
      await at('#closePrintPreview').click();
      await at('#printOptionsButton').click();
      await at('#doPrint').click();
      assert.match(await page.evaluate(() => mock.printed), /Other Patient/);
    }

    await at('#appointmentDate').fill('2026-11-19');
    await wait('#appointmentGroups', 'Own Patient on next date');
    await at('#printOptionsButton').click();
    await at('input[value="comments"]').check();
    await at('#printAttending').selectOption('1253867');
    await at('#doPrint').click();
    const selectedPrint = await page.evaluate(() => mock.printed);
    assert.match(selectedPrint, /Other Patient on next date/);
    assert.doesNotMatch(selectedPrint, /Own Patient/);
    assert.match(selectedPrint, /Nov 19|November 19|19 Nov/);
    assert(await page.evaluate(() => mock.calls.every(([name]) => name !== 'mrd_onc_nurse_com_print_mpage')));
    assert.equal(await assignmentGets(), explicitGets);

    await page.evaluate(() => { mock.failGet = true; });
    await at('#refreshButton').click();
    await wait('#physicianDropdownButton', 'Assignments Unavailable');
    await page.evaluate(() => { mock.failGet = false; mock.qual = 1; });
    await at('#physicianDropdownButton').click();
    await wait('#physicianAssignmentStatus', 'Unexpected physician assignment response');
    await page.evaluate(() => { delete mock.qual; mock.timeoutGet = true; });
    await at('#physicianDropdownButton').click();
    await at('#physicianDropdownButton').click();
    await page.clock.fastForward(30001);
    await wait('#physicianAssignmentStatus', 'timed out');
    await page.evaluate(() => { mock.timeoutGet = false; mock.assignments = []; });
    await at('#refreshButton').click();
    await wait('#physicianDropdownButton', '0 of 9');
    await page.evaluate(() => {
      mock.assignments = [{ PHYSICIAN_ID: 1253867, NURSE_PRSNL_ID: '6227469' }];
    });
    await page.clock.setSystemTime(new Date('2026-11-19T05:00:01Z'));
    await page.clock.fastForward(180001);
    await wait('#appointmentGroups', 'Other Patient');
    await at('[data-note="2"]').fill('Synthetic note');
    await at('[data-palette="2"]').click();
    await at('[data-pick="yellow"]').click();
    await at('[data-save="2"]').click();
    await wait('#notice', 'Nurse comment and highlight saved.');
    assert(await page.evaluate(() => mock.calls.some(([name, args]) =>
      name === 'mrd_onc_nurse_notes_save' && args.includes('^Synthetic note^,^yellow^,^SAVE^'))));
    await page.clock.fastForward(5001);
    assert.equal(await at('#notice').textContent(), '');
    await at('#pendingCommentsButton').click();
    assert(await at('#pendingCommentsDialog').isVisible());
    await at('#donePendingComments').click();
    assert.deepEqual(errors, []);
    console.log('Mocked Chromium workflow passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
